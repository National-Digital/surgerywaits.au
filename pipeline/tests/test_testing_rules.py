import re
import socket
import subprocess
from collections.abc import Mapping, Sequence
from pathlib import Path, PurePosixPath

import pytest

ROOT = Path(__file__).resolve().parents[2]
TS_TEST = re.compile(r"\.(?:test|spec)\.[cm]?[jt]sx?$")
# Aliased matchers, such as `const m = expect.toMatchSnapshot`, are out of scope.
SNAPSHOT_MATCHER = re.compile(r"\btoMatch\w*Snapshot\b|\btoHaveScreenshot\b")
COVERAGE_GATE = re.compile(r"\bthresholds?\b|fail[-_]under")
COVERAGE_FILE = re.compile(
    r"(?:^|/)(?:[^/]*\.config\.(?:ts|mts|js|mjs)|package\.json|pyproject\.toml|setup\.cfg|\.coveragerc)$"
    r"|^\.github/(?:workflows|actions)/.*\.ya?ml$"
)
LINE_COMMENT = re.compile(r"(?m)^\s*(?://|#).*$")


def tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z"],  # noqa: S607 - git is resolved from PATH on purpose
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [p for p in out.split("\0") if p]


def snapshot_files(paths: Sequence[str]) -> list[str]:
    return [
        p
        for p in paths
        if p.endswith(".snap")
        or any(
            d == "__snapshots__" or d.endswith("-snapshots") for d in PurePosixPath(p).parts[:-1]
        )
    ]


def snapshot_calls(sources: Mapping[str, str]) -> list[str]:
    return [name for name, text in sources.items() if SNAPSHOT_MATCHER.search(text)]


def coverage_gates(sources: Mapping[str, str]) -> list[str]:
    return [
        name for name, text in sources.items() if COVERAGE_GATE.search(LINE_COMMENT.sub("", text))
    ]


def test_snapshot_directory_fixture_is_caught() -> None:
    paths = ["site/src/__snapshots__/page.test.ts.snap", "site/src/lib/wait.test.ts"]
    assert snapshot_files(paths) == ["site/src/__snapshots__/page.test.ts.snap"]


def test_playwright_snapshot_directory_fixture_is_caught() -> None:
    paths = ["site/e2e/home.spec.ts-snapshots/home-chromium.png", "site/e2e/home.spec.ts"]
    assert snapshot_files(paths) == ["site/e2e/home.spec.ts-snapshots/home-chromium.png"]


def test_stray_snap_file_fixture_is_caught() -> None:
    assert snapshot_files(["scripts/output.snap"]) == ["scripts/output.snap"]


def test_no_snapshot_file_is_tracked() -> None:
    assert snapshot_files(tracked_files()) == []


@pytest.mark.parametrize(
    "line",
    [
        "expect(html).toMatchSnapshot();",
        "expect(html).toMatchInlineSnapshot(`<p>hi</p>`);",
        "await expect(html).toMatchFileSnapshot('./page.html');",
        "expect(page).toMatchSvgSnapshot();",
        "await expect(page).toHaveScreenshot('home.png');",
    ],
)
def test_snapshot_matcher_fixture_is_caught(line: str) -> None:
    assert snapshot_calls({"a.test.ts": line, "b.test.ts": "expect(x).toBe(1);"}) == ["a.test.ts"]


def test_an_aria_snapshot_call_is_not_a_snapshot_matcher() -> None:
    assert (
        snapshot_calls({"a.test.ts": "const tree = await page.locator('main').ariaSnapshot();"})
        == []
    )


def test_no_typescript_test_uses_a_snapshot_matcher() -> None:
    tests = [p for p in tracked_files() if TS_TEST.search(p)]
    assert tests
    assert snapshot_calls({p: (ROOT / p).read_text("utf-8") for p in tests}) == []


@pytest.mark.parametrize(
    "text",
    [
        "test: { coverage: { thresholds: { lines: 80 } } }",
        "test: { coverage: { thresholds: { 100: true } } }",
        'addopts = ["--cov-fail-under=80"]',
        "fail_under = 90",
        "      - run: npx vitest run --coverage.thresholds.lines=80",
        "      - run: uv run pytest --cov --cov-fail-under=80",
    ],
)
def test_coverage_gate_fixture_is_caught(text: str) -> None:
    assert coverage_gates({"config": text}) == ["config"]


@pytest.mark.parametrize(
    "path",
    [
        "site/vitest.config.mts",
        "worker/vitest.config.js",
        "packages/a/package.json",
        "pipeline/pyproject.toml",
        "setup.cfg",
        ".coveragerc",
        ".github/workflows/ci.yml",
        ".github/actions/test/action.yaml",
    ],
)
def test_coverage_file_fixture_is_scanned(path: str) -> None:
    assert COVERAGE_FILE.search(path)


@pytest.mark.parametrize("path", ["site/src/lib/wait.ts", "README.md", "docs/package.json.md"])
def test_other_files_are_not_scanned_for_coverage_gates(path: str) -> None:
    assert not COVERAGE_FILE.search(path)


def test_a_comment_about_thresholds_is_not_a_coverage_gate() -> None:
    assert coverage_gates({"config": "// no thresholds here\nexport default {};"}) == []


def test_no_coverage_percentage_gate_is_configured() -> None:
    names = [p for p in tracked_files() if COVERAGE_FILE.search(p)]
    assert "vitest.config.ts" in names
    assert coverage_gates({n: (ROOT / n).read_text("utf-8") for n in names}) == []


def test_a_connection_to_a_remote_address_is_refused() -> None:
    with pytest.raises(RuntimeError, match="tests never touch the network"):
        socket.create_connection(("192.0.2.1", 80), timeout=1)


def test_a_lookup_of_a_remote_name_is_refused() -> None:
    with pytest.raises(RuntimeError, match="tests never touch the network"):
        socket.getaddrinfo("example.com", 443)


def test_a_connection_to_localhost_is_allowed() -> None:
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        server.listen()
        with socket.create_connection(server.getsockname(), timeout=1):
            pass


def test_a_remote_hostname_lookup_is_refused() -> None:
    with pytest.raises(RuntimeError, match="tests never touch the network"):
        socket.gethostbyname("example.com")


def test_a_remote_hostname_lookup_with_aliases_is_refused() -> None:
    with pytest.raises(RuntimeError, match="tests never touch the network"):
        socket.gethostbyname_ex("example.com")


def test_a_reverse_lookup_of_a_remote_address_is_refused() -> None:
    with pytest.raises(RuntimeError, match="tests never touch the network"):
        socket.gethostbyaddr("192.0.2.1")


def test_sendto_a_remote_address_is_refused() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        with pytest.raises(RuntimeError, match="tests never touch the network"):
            udp.sendto(b"x", ("192.0.2.1", 9))
        with pytest.raises(RuntimeError, match="tests never touch the network"):
            udp.sendto(b"x", 0, ("192.0.2.1", 9))


def test_sendmsg_to_a_remote_address_is_refused() -> None:
    with (
        socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp,
        pytest.raises(RuntimeError, match="tests never touch the network"),
    ):
        udp.sendmsg([b"x"], [], 0, ("192.0.2.1", 9))


def test_sendto_localhost_is_allowed() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp:
        assert udp.sendto(b"x", ("127.0.0.1", 9)) == 1


def test_a_reverse_name_lookup_is_refused() -> None:
    with pytest.raises(RuntimeError, match="tests never touch the network"):
        socket.getnameinfo(("192.0.2.1", 80), 0)


def test_a_reverse_name_lookup_of_localhost_is_allowed() -> None:
    host, _service = socket.getnameinfo(("127.0.0.1", 80), 0)
    assert host
