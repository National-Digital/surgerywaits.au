import ast
import json
import re
import subprocess
import textwrap
from collections.abc import Callable, Mapping
from pathlib import Path, PurePosixPath
from urllib.parse import unquote

import pytest

ROOT = Path(__file__).resolve().parents[2]
MIN_PARTS = 2

TITLE = r"(?:\s+(?:\"[^\"]*\"|'[^']*'|\([^)]*\)))?"
TARGET = r"(?:<([^>\n]*)>|((?:[^()\s]|\([^()\s]*\))+))"
INLINE_LINK = re.compile(rf"\[[^\]]*\]\(\s*{TARGET}{TITLE}\s*\)")
DEFINITION = re.compile(rf"^ {{0,3}}\[[^\]]+\]:\s*{TARGET}{TITLE}[ \t]*$", re.MULTILINE)
HREF = re.compile(r"\bhref\s*=\s*[\"']([^\"']*)[\"']", re.IGNORECASE)
HTML_ANCHOR = re.compile(r"\b(?:id|name)\s*=\s*[\"']([^\"']+)[\"']", re.IGNORECASE)
COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
CODE = re.compile(r"`([^`\n]+)`")
FENCE = re.compile(r"^\s*(```|~~~).*?(?:^\s*\1[ \t]*$|\Z)", re.MULTILINE | re.DOTALL)
HEADING = re.compile(
    r"^ {0,3}#{1,6}[ \t]+(?P<atx>.+?)[ \t]*#*[ \t]*$"
    r"|^ {0,3}(?P<setext>[^\s#>|*+-][^\n]*)\n {0,3}(?:=+|-+)[ \t]*$",
    re.MULTILINE,
)
NPM_RUN = re.compile(r"\bnpm run(?: -{1,2}[A-Za-z0-9][\w-]*)* ([\w:.-]*\w)")

Exists = Callable[[str], bool]


def slug(heading: str) -> str:
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", heading)
    text = re.sub(r"[`*_~]", "", text).lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def anchors(markdown: str) -> set[str]:
    body = FENCE.sub("", markdown)
    seen: dict[str, int] = {}
    found = {a.lower() for a in HTML_ANCHOR.findall(body)}
    for m in HEADING.finditer(body):
        base = slug((m["atx"] or m["setext"]).strip())
        n = seen.get(base, 0)
        seen[base] = n + 1
        found.add(base if n == 0 else f"{base}-{n}")
    return found


def _resolve(doc: str, target: str) -> str:
    if target.startswith("/"):
        return str(PurePosixPath(target.lstrip("/")))
    parts: list[str] = []
    for p in [*PurePosixPath(doc).parent.parts, *PurePosixPath(target).parts]:
        if p == "..":
            if parts:
                parts.pop()
        elif p != ".":
            parts.append(p)
    return "/".join(parts)


def _targets(text: str) -> list[str]:
    body = COMMENT.sub("", FENCE.sub("", text))
    found = [a or b for a, b in [*INLINE_LINK.findall(body), *DEFINITION.findall(body)]]
    return [*found, *HREF.findall(body)]


def broken_links(docs: Mapping[str, str], exists: Exists) -> list[str]:
    bad: list[str] = []
    for doc, text in sorted(docs.items()):
        for target in _targets(text):
            if re.match(r"[a-z][a-z0-9+.-]*:", target, re.IGNORECASE) or target.startswith("//"):
                continue
            path, _, frag = target.partition("#")
            path = unquote(path.partition("?")[0])
            frag = unquote(frag)
            resolved = _resolve(doc, path) if path else doc
            if path and not exists(resolved):
                bad.append(f"{doc}: link to {target} has no file")
            elif (
                frag
                and resolved.endswith(".md")
                and resolved in docs
                and frag.lower() not in anchors(docs[resolved])
            ):
                bad.append(f"{doc}: link to {target} has no such heading")
    return bad


def missing_paths(docs: Mapping[str, str], exists: Exists, top: set[str]) -> list[str]:
    """Only a token under a real top-level entry is checked, so planned and external names pass."""
    bad: list[str] = []
    for doc, text in sorted(docs.items()):
        for token in CODE.findall(FENCE.sub("", text)):
            if re.search(r"[\s<>{}*$|=,:@()]", token) or "/" not in token:
                continue
            path = token.removeprefix("./")
            if path.startswith("/") or path.split("/")[0] not in top:
                continue
            if not exists(path.rstrip("/")):
                bad.append(f"{doc}: `{token}` is not in the repository")
    return bad


def unknown_scripts(docs: Mapping[str, str], scripts: set[str]) -> list[str]:
    return [
        f"{doc}: npm run {name} is not a package.json script"
        for doc, text in sorted(docs.items())
        for name in NPM_RUN.findall(text)
        if name not in scripts
    ]


def _matrix_values(block: str, key: str) -> list[str]:
    if re.search(r"^\s+include:", block, re.MULTILINE):
        msg = "matrix.include is not supported by the checks-table test; extend check_names"
        raise ValueError(msg)
    inline = re.search(rf"^\s+{key}:\s*\[([^\]]*)\]", block, re.MULTILINE)
    if inline:
        return [v.strip().strip("'\"") for v in inline.group(1).split(",")]
    listed = re.search(rf"^(\s+){key}:\s*\n((?:\1\s+-\s*.+\n?)+)", block, re.MULTILINE)
    if listed:
        return [
            v.strip().removeprefix("-").strip().strip("'\"") for v in listed.group(2).splitlines()
        ]
    msg = f"matrix.{key} has no list the checks-table test can read; extend check_names"
    raise ValueError(msg)


def _unquote(value: str) -> str:
    quoted = re.match(r"([\"'])(.*?)\1", value)
    return quoted.group(2) if quoted else re.sub(r"\s+#.*$", "", value).strip()


def check_names(workflows: Mapping[str, str]) -> set[str]:
    """Job names as the check reports them: `name:`, else the job id, with a matrix expanded."""
    names: set[str] = set()
    for text in workflows.values():
        jobs = re.split(r"^jobs:\s*$", text, maxsplit=1, flags=re.MULTILINE)
        if len(jobs) < MIN_PARTS:
            continue
        for job_id, block in re.findall(
            r"^  ([\w-]+):[ \t]*\n((?:(?:    .*)?\n|\Z)*)", jobs[1] + "\n", re.MULTILINE
        ):
            found = re.search(r"^    name:\s*(.+?)\s*$", block, re.MULTILINE)
            name = _unquote(found.group(1)) if found else job_id
            keys = set(re.findall(r"\$\{\{\s*matrix\.([\w-]+)\s*\}\}", name))
            if not keys:
                names.add(name)
            elif len(keys) > 1:
                msg = f"job {job_id} names two matrix keys; extend check_names"
                raise ValueError(msg)
            else:
                key = keys.pop()
                for v in _matrix_values(block, key):
                    names.add(re.sub(r"\$\{\{\s*matrix\." + key + r"\s*\}\}", v, name))
    return names


def table_checks(contributing: str) -> list[str]:
    """First cells of the table whose header cell is `Check`."""
    lines = contributing.splitlines()
    for i, line in enumerate(lines):
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if line.lstrip().startswith("|") and cells[0] == "Check":
            rows: list[str] = []
            for row in lines[i + 2 :]:
                if not row.lstrip().startswith("|"):
                    break
                rows.append(row.strip().strip("|").split("|")[0].strip().replace("`", ""))
            return rows
    return []


def undefined_checks(contributing: str, workflows: Mapping[str, str]) -> list[str]:
    defined = check_names(workflows)
    return [
        f"CONTRIBUTING.md lists {c}, which no workflow defines"
        for c in table_checks(contributing)
        if c not in defined
    ]


SEP = "\u203a"
RULES_HEADING = "## Rules that decide the code"
ENFORCED = " — enforced by "
CITATION = re.compile(
    r"`(?P<py>[^`\s:]+\.py)::(?P<fn>test_\w+)`(?P<pp>\ \(planned\))?"
    rf'|`(?P<ts>[^`\s]+\.test\.ts)` {SEP} "(?P<title>[^"]+)"(?P<tp>\ \(planned\))?'
    r"|CI job `(?P<job>[^`]+)`"
)
TS_CALL = re.compile(r"(?:^|[;{}])\s*(?:it|test)(?P<mod>\.todo|\.skip)?\(\s*")

Read = Callable[[str], str | None]


def rule_blocks(architecture: str) -> list[str]:
    """Each rule is its bullet plus the indented lines that continue it."""
    _, _, rest = architecture.partition(RULES_HEADING)
    section = re.split(r"^## ", rest, maxsplit=1, flags=re.MULTILINE)[0]
    blocks: list[str] = []
    open_rule = False
    for line in section.splitlines():
        if re.match(r"(?:[-*]|\d+\.) ", line):
            blocks.append(line)
            open_rule = True
        elif open_rule and line[:1] in {" ", "\t"} and line.strip():
            blocks[-1] += " " + line.strip()
        else:
            open_rule = False
    return blocks


def _is_planned_skip(decorator: ast.expr) -> bool:
    return (
        isinstance(decorator, ast.Call)
        and isinstance(decorator.func, ast.Attribute)
        and decorator.func.attr == "skip"
        and any(
            k.arg == "reason"
            and isinstance(k.value, ast.Constant)
            and str(k.value.value).startswith("planned")
            for k in decorator.keywords
        )
    )


def python_tests(source: str) -> dict[str, bool]:
    """Test functions at module or class level, each mapped to whether it is a planned skip."""
    found: dict[str, bool] = {}

    def visit(body: list[ast.stmt]) -> None:
        for node in body:
            if isinstance(node, ast.ClassDef):
                visit(node.body)
            elif isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and node.name.startswith(
                "test_"
            ):
                found[node.name] = any(_is_planned_skip(d) for d in node.decorator_list)

    try:
        visit(ast.parse(source).body)
    except SyntaxError:
        return {}
    return found


def _mask_ts(source: str) -> tuple[str, dict[int, int]]:
    """Blank comments and string contents, and record where each string starts and ends."""
    masked = list(source)
    strings: dict[int, int] = {}
    i, n = 0, len(source)
    while i < n:
        if source.startswith(("//", "/*"), i):
            end = source.find("\n" if source[i + 1] == "/" else "*/", i + 2)
            j = n if end < 0 else end + (0 if source[i + 1] == "/" else 2)
            masked[i:j] = [" "] * (j - i)
            i = j
        elif source[i] in "\"'`":
            j = i + 1
            while j < n and source[j] != source[i]:
                j += 2 if source[j] == "\\" else 1
            strings[i] = j
            masked[i + 1 : j] = [" "] * (min(j, n) - i - 1)
            i = j + 1
        else:
            i += 1
    return "".join(masked), strings


def vitest_titles(source: str) -> dict[str, bool]:
    """Titles of it, it.todo, test and test.todo calls that open a statement, mapped to todo."""
    masked, strings = _mask_ts(source)
    found: dict[str, bool] = {}
    for m in TS_CALL.finditer(masked):
        if m.end() not in strings:
            continue
        title = re.sub(r"\\(.)", r"\1", source[m.end() + 1 : strings[m.end()]])
        found[title] = found.get(title, True) and m["mod"] in {".todo", ".skip"}
    return found


def _problem(name: str, ref: str, *, state: bool | None, marked: bool) -> str:
    """`state` is None when the target is missing, else whether it is a pending test."""
    if state is None:
        return f"rule {name} names {ref}, which does not exist"
    if state and not marked:
        return f"rule {name} cites {ref}, a pending test, without (planned)"
    if marked and not state:
        return f"rule {name} marks {ref} as planned but it is a real test"
    return ""


def unproven_rules(architecture: str, read: Read, jobs: set[str]) -> list[str]:
    """Every reference on a rule must be well formed, exist, and be marked planned iff pending."""
    bad: list[str] = []
    for block in rule_blocks(architecture):
        parts = block.split("**")
        name = parts[1].rstrip(".") if len(parts) > MIN_PARTS else block[:30]
        _, found, tail = block.partition(ENFORCED)
        if not found:
            bad.append(f"rule {name} names no test or check")
            continue
        pos = 0
        while True:
            m = CITATION.match(tail, pos)
            if not m:
                bad.append(f"rule {name} has a malformed reference at: {tail[pos : pos + 40]}")
                break
            source = read(m["py"] or m["ts"]) if (m["py"] or m["ts"]) else None
            if m["py"]:
                tests = python_tests(source) if source is not None else {}
                ref = f"{m['py']}::{m['fn']}"
                issue = _problem(name, ref, state=tests.get(m["fn"]), marked=bool(m["pp"]))
            elif m["ts"]:
                titles = vitest_titles(source) if source is not None else {}
                ref = f'{m["ts"]} {SEP} "{m["title"]}"'
                issue = _problem(name, ref, state=titles.get(m["title"]), marked=bool(m["tp"]))
            else:
                ref = f"CI job {m['job']}"
                issue = (
                    ""
                    if m["job"] in jobs
                    else f"rule {name} names {ref}, which no workflow defines"
                )
            if issue:
                bad.append(issue)
            pos = m.end()
            if tail[pos:] == ".":
                break
            if tail[pos : pos + 2] != "; ":
                bad.append(f"rule {name} has a malformed reference at: {tail[pos : pos + 40]}")
                break
            pos += 2
    return bad


def _tracked() -> list[str]:
    out = subprocess.run(  # noqa: S603
        ["git", "-C", str(ROOT), "ls-files", "-z"],  # noqa: S607
        check=True, capture_output=True, text=True,
    ).stdout  # fmt: skip
    return [p for p in out.split("\0") if p]


def _repo_docs() -> dict[str, str]:
    files = _tracked()
    wanted = [f for f in files if f.endswith(".md") or f.startswith(".github/ISSUE_TEMPLATE/")]
    return {f: (ROOT / f).read_text(encoding="utf-8") for f in wanted if (ROOT / f).is_file()}


def _repo_exists() -> Exists:
    files = set(_tracked())
    dirs = {str(d) for f in files for d in PurePosixPath(f).parents}
    return lambda p: p in files or p in dirs


def _top() -> set[str]:
    return {f.split("/")[0] for f in _tracked()}


def _workflows() -> dict[str, str]:
    return {
        f.name: f.read_text(encoding="utf-8")
        for f in sorted((ROOT / ".github" / "workflows").glob("*.yml"))
    }


# The rules, proved on in-memory fixtures so a rule that stops firing is itself a failure.


def _exists(*present: str) -> Exists:
    return lambda p: p in present


def test_a_link_to_a_missing_file_is_caught() -> None:
    docs = {"a.md": "[x](docs/gone.md) [y](docs/here.md)", "docs/here.md": "# Here"}
    assert broken_links(docs, _exists("docs/here.md")) == ["a.md: link to docs/gone.md has no file"]


def test_a_link_to_a_missing_anchor_is_caught() -> None:
    docs = {
        "a.md": (
            "[ok](b.md#a-b-c) [dup](b.md#dup-1) [self](#top) [bad](b.md#nope) [no](#nope)\n# Top"
        ),
        "b.md": "## A `b` C!\n# Dup\n# Dup\n```\n# Not a heading\n```",
    }
    assert broken_links(docs, _exists("a.md", "b.md")) == [
        "a.md: link to b.md#nope has no such heading",
        "a.md: link to #nope has no such heading",
    ]


def test_relative_links_resolve_from_the_linking_file() -> None:
    docs = {"docs/a.md": "[up](../README.md) [web](https://x.test/y) [m](mailto:a@b.test)"}
    assert broken_links(docs, _exists("README.md")) == []


def test_reference_definitions_are_checked() -> None:
    docs = {
        "a.md": '[d]: gone.md#x\n[e]: <b.md#nope> "Title"\n[f]: b.md#here (Title)\n',
        "b.md": "# Here",
    }
    assert sorted(broken_links(docs, _exists("b.md"))) == [
        "a.md: link to b.md#nope has no such heading",
        "a.md: link to gone.md#x has no file",
    ]


def test_html_hrefs_are_checked() -> None:
    docs = {
        "a.md": '<a href="gone.md">x</a> <a href=\'b.md#nope\'>y</a> <a href="b.md#here">z</a>',
        "b.md": "# Here",
    }
    assert broken_links(docs, _exists("b.md")) == [
        "a.md: link to gone.md has no file",
        "a.md: link to b.md#nope has no such heading",
    ]


def test_link_titles_in_every_form_are_accepted() -> None:
    docs = {"a.md": "[a](b.md \"t\") [b](b.md 't') [c](b.md (t)) [d](b.md#nope 't')", "b.md": "# B"}
    assert broken_links(docs, _exists("b.md")) == ["a.md: link to b.md#nope has no such heading"]


def test_encoded_paths_balanced_parentheses_and_angle_targets() -> None:
    docs = {
        "a.md": (
            "[a](my%20file.md) [b](f(1).md) [c](<my file.md>) [d](<gone file.md>) "
            "[e](x%20y.md#nope)"
        ),
        "x y.md": "# X",
    }
    present = ("my file.md", "f(1).md", "x y.md")
    assert broken_links(docs, _exists(*present)) == [
        "a.md: link to gone file.md has no file",
        "a.md: link to x%20y.md#nope has no such heading",
    ]


def test_html_ids_and_names_are_anchors() -> None:
    docs = {
        "a.md": "[a](b.md#one) [b](b.md#two) [c](b.md#three)",
        "b.md": "<a id=\"one\"></a><a name='two'>",
    }
    assert broken_links(docs, _exists("b.md")) == ["a.md: link to b.md#three has no such heading"]


def test_an_unclosed_fence_runs_to_the_end_of_the_file() -> None:
    docs = {"a.md": "[a](gone.md)\n```\n[b](gone2.md)\n`docs/gone.md`\n"}
    assert broken_links(docs, _exists()) == ["a.md: link to gone.md has no file"]
    assert missing_paths(docs, _exists(), {"docs"}) == []


def test_setext_headings_are_anchors() -> None:
    docs = {
        "a.md": "[a](b.md#big-one) [b](b.md#small) [c](b.md#table)",
        "b.md": "Big one\n=======\n\nSmall\n---\n\n| h |\n| - |\n",
    }
    assert broken_links(docs, _exists("b.md")) == ["a.md: link to b.md#table has no such heading"]


def test_inline_code_naming_a_missing_path_is_caught() -> None:
    docs = {"a.md": "See `docs/gone.md`, `docs/here.md`, `./docs/x/` and `pipeline/`."}
    present = {"docs/here.md", "pipeline"}
    assert missing_paths(docs, _exists(*present), {"docs", "pipeline"}) == [
        "a.md: `docs/gone.md` is not in the repository",
        "a.md: `./docs/x/` is not in the repository",
    ]


def test_planned_external_bare_and_rooted_names_are_not_checked() -> None:
    docs = {
        "a.md": "`contract/` `owner/repo` `nope.toml` `/d/<slug>/v/<date>/data.parquet` "
        "`/api/v1/` `docs/<name>/x.ts` `**/*.md` `docs/a b` `npm run lint`"
    }
    assert missing_paths(docs, _exists(), {"docs", "pipeline"}) == []


def test_a_trailing_dot_is_not_part_of_a_script_name() -> None:
    docs = {"a.md": "Run npm run lint. Then npm run nope."}
    assert unknown_scripts(docs, {"lint"}) == ["a.md: npm run nope is not a package.json script"]


def test_html_comments_are_not_checked_for_links() -> None:
    docs = {"a.md": "<!-- [x](gone.md)\n[y](gone2.md) -->\n[z](gone3.md)"}
    assert broken_links(docs, _exists()) == ["a.md: link to gone3.md has no file"]


def test_a_trailing_comment_is_not_part_of_a_job_name() -> None:
    text = "jobs:\n  a:\n    name: Site checks # required\n  b:\n    name: 'Has # inside'\n"
    assert check_names({"w.yml": text}) == {"Site checks", "Has # inside"}


def test_an_unknown_npm_script_is_caught() -> None:
    docs = {"a.md": "Run `npm run lint`, then\n```\nnpm run nope\n```"}
    assert unknown_scripts(docs, {"lint"}) == ["a.md: npm run nope is not a package.json script"]


TABLE = (
    "## Checks on each pull request\n\nText | with a pipe\n\n| Check | What |\n| --- | --- |\n"
    "| Site checks | x |\n| `Analyze (python)` | x |\n| Pipeline checks | x |\n"
    "| Unnamed | x |\n\n## Next\n"
)


def test_a_check_no_workflow_defines_is_caught() -> None:
    workflow = (
        "jobs:\n  a:\n    name: Site checks\n  b:\n    name: Analyze (${{ matrix.language }})\n"
        "    strategy:\n      matrix:\n        language: [actions, python]\n"
        "  Unnamed:\n    runs-on: x\n"
    )
    assert undefined_checks(TABLE, {"ci.yml": workflow}) == [
        "CONTRIBUTING.md lists Pipeline checks, which no workflow defines"
    ]
    assert undefined_checks(TABLE, {}) != []


def test_block_list_matrices_expand_and_include_fails_loudly() -> None:
    block = (
        "jobs:\n  b:\n    name: Analyze (${{ matrix.language }})\n"
        "    strategy:\n      matrix:\n        language:\n          - actions\n          - python\n"
    )
    assert check_names({"w.yml": block}) == {"Analyze (actions)", "Analyze (python)"}
    include = block.replace("language:\n", "include:\n          - language: x\n        language:\n")
    with pytest.raises(ValueError, match=r"matrix\.include"):
        check_names({"w.yml": include})


PY_FIXTURE = textwrap.dedent(
    """\
    def test_real() -> None:
        pass

    @pytest.mark.skip(reason="planned: later")
    def test_pending() -> None:
        raise NotImplementedError

    def helper() -> None:
        def test_nested() -> None:
            pass

    class TestGroup:
        def test_method(self) -> None:
            pass

    \"\"\"
    def test_in_docstring() -> None:
    \"\"\"
    """
)
TS_FIXTURE = textwrap.dedent(
    """\
    describe('x', () => {
      it.todo("a pending title");
      it('a real title', () => {});
      // it.todo('in a comment');
      /* it('in a block comment', () => {}); */
      const s = "; it.todo('in a string');";
      regex.test('on a regex');
      it.skip('a skipped title', () => {});
      it.todo(
        'quoted \\'inner\\' title',
      );
    });
    """
)
RULE_FILES = {"t.py": PY_FIXTURE, "g.test.ts": TS_FIXTURE}
PASSING = [
    "- **One.** Text — enforced by `t.py::test_real`; `t.py::test_pending` (planned).",
    f'- **Two.** Text — enforced by `g.test.ts` {SEP} "a real title"; CI job `Site checks`.',
    f'* **Three.** Text — enforced by `g.test.ts` {SEP} "a pending title" (planned);',
    f"""  `g.test.ts` {SEP} "quoted 'inner' title" (planned); `t.py::test_method`.""",
]


def _read(path: str) -> str | None:
    return RULE_FILES.get(path)


def _rules(*lines: str) -> str:
    return "# A\n\n" + RULES_HEADING + "\n\nIntro.\n\n" + "\n".join(lines) + "\n\n## Next\n- x\n"


def _unproven(*lines: str) -> list[str]:
    return unproven_rules(_rules(*lines), _read, {"Site checks"})


def test_rules_citing_real_and_planned_tests_titles_and_jobs_pass() -> None:
    assert _unproven(*PASSING) == []


def test_a_rule_citing_a_missing_test_function_is_caught() -> None:
    assert _unproven("- **One.** T — enforced by `t.py::test_gone`; `nofile.py::test_real`.") == [
        "rule One names t.py::test_gone, which does not exist",
        "rule One names nofile.py::test_real, which does not exist",
    ]


def test_a_helper_a_nested_def_and_a_docstring_def_are_not_tests() -> None:
    line = "- **One.** T — enforced by `t.py::test_nested`; `t.py::test_in_docstring`."
    assert _unproven(line) == [
        "rule One names t.py::test_nested, which does not exist",
        "rule One names t.py::test_in_docstring, which does not exist",
    ]
    assert _unproven("- **One.** T — enforced by `t.py::helper`.") == [
        "rule One has a malformed reference at: `t.py::helper`."
    ]


def test_a_title_in_a_comment_a_string_or_a_regex_call_is_not_a_test() -> None:
    for title in ("in a comment", "in a block comment", "in a string", "on a regex"):
        line = f'- **One.** T — enforced by `g.test.ts` {SEP} "{title}" (planned).'
        assert _unproven(line) == [
            f'rule One names g.test.ts {SEP} "{title}", which does not exist'
        ]


def test_a_missing_todo_title_and_a_missing_ci_job_are_caught() -> None:
    line = f'- **One.** T — enforced by `g.test.ts` {SEP} "a gone title"; CI job `Gone job`.'
    assert _unproven(line) == [
        f'rule One names g.test.ts {SEP} "a gone title", which does not exist',
        "rule One names CI job Gone job, which no workflow defines",
    ]


def test_a_reference_on_a_continuation_line_is_checked() -> None:
    assert _unproven("- **One.** Text", "  — enforced by `t.py::test_gone`.") == [
        "rule One names t.py::test_gone, which does not exist"
    ]
    assert _unproven(
        "* **One.** Text — enforced by `t.py::test_real`;", "  `t.py::test_gone`."
    ) == ["rule One names t.py::test_gone, which does not exist"]


def test_a_numbered_rule_is_checked() -> None:
    assert _unproven("1. **One.** T — enforced by `t.py::test_gone`.") == [
        "rule One names t.py::test_gone, which does not exist"
    ]


def test_a_skipped_vitest_test_is_pending() -> None:
    assert _unproven(f'- **One.** T — enforced by `g.test.ts` {SEP} "a skipped title".') == [
        f'rule One cites g.test.ts {SEP} "a skipped title", a pending test, without (planned)'
    ]
    assert (
        _unproven(f'- **One.** T — enforced by `g.test.ts` {SEP} "a skipped title" (planned).')
        == []
    )


def test_a_malformed_reference_beside_a_valid_one_is_caught() -> None:
    for tail in (
        "`t.py::test_real`; `t.py`.",
        "`t.py::test_real`; CI job Site checks.",
        "`t.py::test_real` and `t.py::test_pending` (planned).",
        f"`t.py::test_real`; `g.test.ts` {SEP} a real title.",
    ):
        issues = _unproven(f"- **One.** T — enforced by {tail}")
        assert len(issues) == 1
        assert issues[0].startswith("rule One has a malformed reference at: ")


def test_a_rule_naming_no_test_is_caught_and_other_sections_are_ignored() -> None:
    assert _unproven("- **One.** Text with no reference.") == ["rule One names no test or check"]


def test_planned_is_required_exactly_when_the_target_is_pending() -> None:
    assert _unproven("- **One.** T — enforced by `t.py::test_pending`.") == [
        "rule One cites t.py::test_pending, a pending test, without (planned)"
    ]
    assert _unproven("- **One.** T — enforced by `t.py::test_real` (planned).") == [
        "rule One marks t.py::test_real as planned but it is a real test"
    ]
    assert _unproven(f'- **One.** T — enforced by `g.test.ts` {SEP} "a pending title".') == [
        f'rule One cites g.test.ts {SEP} "a pending title", a pending test, without (planned)'
    ]
    assert _unproven(f'- **One.** T — enforced by `g.test.ts` {SEP} "a real title" (planned).') == [
        f'rule One marks g.test.ts {SEP} "a real title" as planned but it is a real test'
    ]


# The rules, applied to the repository.


def test_every_link_in_the_documents_resolves() -> None:
    assert broken_links(_repo_docs(), _repo_exists()) == []


def test_every_path_named_in_the_documents_exists() -> None:
    assert missing_paths(_repo_docs(), _repo_exists(), _top()) == []


def test_every_npm_script_named_in_the_documents_exists() -> None:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    assert unknown_scripts(_repo_docs(), set(package["scripts"])) == []


def test_every_check_in_the_contributing_table_is_defined_by_a_workflow() -> None:
    contributing = (ROOT / "CONTRIBUTING.md").read_text(encoding="utf-8")
    assert table_checks(contributing) != []
    assert undefined_checks(contributing, _workflows()) == []


def test_every_rule_in_the_architecture_names_a_test_that_exists() -> None:
    architecture = (ROOT / "docs" / "ARCHITECTURE.md").read_text(encoding="utf-8")
    assert rule_blocks(architecture) != []

    def read(path: str) -> str | None:
        file = ROOT / path
        return file.read_text(encoding="utf-8") if file.is_file() else None

    assert unproven_rules(architecture, read, check_names(_workflows())) == []
