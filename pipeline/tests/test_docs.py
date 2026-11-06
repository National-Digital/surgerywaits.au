import json
import re
import subprocess
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
