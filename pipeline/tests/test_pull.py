import json
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from fakes import BODY, GOOD, FakeOpener, FakeResponse, Sleeps, http_error, make_entry
from surgerywaits.manifest import MANIFEST_PATH, Entry
from surgerywaits.pull import ATTEMPTS, USER_AGENT, NoRedirect, PullError, main, pull


def cached(cache: Path) -> list[str]:
    return sorted(p.name for p in cache.iterdir())


def test_a_good_download_is_cached_by_its_hash(tmp_path: Path) -> None:
    opener = FakeOpener(FakeResponse(BODY))
    files = pull((make_entry(),), tmp_path, opener, Sleeps())
    assert files == {"demo": tmp_path / GOOD}
    assert (tmp_path / GOOD).read_bytes() == BODY
    assert cached(tmp_path) == [GOOD]
    assert opener.requests[0].full_url == make_entry().url
    assert opener.requests[0].get_header("User-agent") == USER_AGENT


def test_a_cached_file_makes_no_request(tmp_path: Path) -> None:
    (tmp_path / GOOD).write_bytes(BODY)
    opener = FakeOpener(http_error(500))
    pull((make_entry(),), tmp_path, opener, Sleeps())
    assert opener.requests == []


def test_a_corrupt_cached_file_is_fetched_again(tmp_path: Path) -> None:
    (tmp_path / GOOD).write_bytes(b"damaged")
    pull((make_entry(),), tmp_path, FakeOpener(FakeResponse(BODY)), Sleeps())
    assert (tmp_path / GOOD).read_bytes() == BODY


def test_a_digest_mismatch_fails_closed_with_nothing_cached(tmp_path: Path) -> None:
    opener = FakeOpener(FakeResponse(b"tampered"))
    with pytest.raises(PullError, match="served sha256"):
        pull((make_entry(),), tmp_path, opener, Sleeps())
    assert cached(tmp_path) == []
    assert len(opener.requests) == 1


def test_an_incomplete_read_is_retried_then_succeeds(tmp_path: Path) -> None:
    opener = FakeOpener(FakeResponse(BODY, fail_after=5000), FakeResponse(BODY))
    sleeps = Sleeps()
    pull((make_entry(),), tmp_path, opener, sleeps)
    assert len(opener.requests) == 2  # noqa: PLR2004
    assert len(sleeps.waits) == 1
    assert cached(tmp_path) == [GOOD]


@pytest.mark.parametrize(
    "failure",
    [ConnectionResetError(), TimeoutError(), urllib.error.URLError("down"), http_error(503)],
)
def test_other_transport_errors_are_retried(tmp_path: Path, failure: Exception) -> None:
    opener = FakeOpener(failure, FakeResponse(BODY))
    pull((make_entry(),), tmp_path, opener, Sleeps())
    assert len(opener.requests) == 2  # noqa: PLR2004


def test_the_retry_limit_is_enforced_and_leaves_nothing(tmp_path: Path) -> None:
    opener = FakeOpener(FakeResponse(BODY, fail_after=100))
    sleeps = Sleeps()
    with pytest.raises(PullError, match="gave up"):
        pull((make_entry(),), tmp_path, opener, sleeps)
    assert len(opener.requests) == ATTEMPTS
    assert len(sleeps.waits) == ATTEMPTS - 1
    assert sleeps.waits == sorted(sleeps.waits)
    assert cached(tmp_path) == []


def test_a_404_fails_at_once(tmp_path: Path) -> None:
    opener = FakeOpener(http_error(404))
    with pytest.raises(PullError, match="HTTP 404"):
        pull((make_entry(),), tmp_path, opener, Sleeps())
    assert len(opener.requests) == 1
    assert cached(tmp_path) == []


def test_a_url_outside_publicdata_is_refused(tmp_path: Path) -> None:
    bad = make_entry()
    bad = Entry(**{**bad.__dict__, "url": "https://example.com/data.parquet"})
    opener = FakeOpener(FakeResponse(BODY))
    with pytest.raises(PullError, match=r"outside publicdata\.au"):
        pull((bad,), tmp_path, opener, Sleeps())
    assert opener.requests == []


def test_a_url_naming_another_version_is_refused(tmp_path: Path) -> None:
    bad = Entry(**{**make_entry().__dict__, "version": "2026-01-03"})
    with pytest.raises(PullError, match=r"outside publicdata\.au"):
        pull((bad,), tmp_path, FakeOpener(FakeResponse(BODY)), Sleeps())


def test_the_redirect_handler_refuses_every_redirect() -> None:
    request = urllib.request.Request("https://publicdata.au/d/demo/v/2026-01-02/data.parquet")
    with pytest.raises(PullError, match="redirect"):
        NoRedirect().redirect_request(request, None, 302, "Found", {}, "https://example.com/x")


@pytest.mark.parametrize("code", [301, 302, 307, 308])
def test_a_redirect_response_is_not_retried(tmp_path: Path, code: int) -> None:
    opener = FakeOpener(http_error(code))
    with pytest.raises(PullError, match=f"HTTP {code}"):
        pull((make_entry(),), tmp_path, opener, Sleeps())
    assert len(opener.requests) == 1


@pytest.mark.parametrize("code", [408, 429])
def test_timeout_and_rate_limit_responses_are_retried(tmp_path: Path, code: int) -> None:
    opener = FakeOpener(http_error(code), FakeResponse(BODY))
    pull((make_entry(),), tmp_path, opener, Sleeps())
    assert len(opener.requests) == 2  # noqa: PLR2004


@pytest.mark.parametrize("code", [400, 401, 403, 410])
def test_other_client_errors_fail_at_once(tmp_path: Path, code: int) -> None:
    opener = FakeOpener(http_error(code))
    with pytest.raises(PullError, match=f"HTTP {code}"):
        pull((make_entry(),), tmp_path, opener, Sleeps())
    assert len(opener.requests) == 1


def test_a_slow_download_passes_its_deadline_and_leaves_nothing(tmp_path: Path) -> None:
    now = [0.0]
    response = FakeResponse(BODY)
    response.on_read = lambda: now.__setitem__(0, now[0] + 400.0)
    opener = FakeOpener(response)
    with pytest.raises(PullError, match="deadline"):
        pull((make_entry(),), tmp_path, opener, Sleeps(), lambda: now[0])
    assert len(opener.requests) == 1
    assert cached(tmp_path) == []


def test_leftover_partial_files_are_swept_first(tmp_path: Path) -> None:
    (tmp_path / ".part-old").write_bytes(b"half")
    pull((make_entry(),), tmp_path, FakeOpener(FakeResponse(BODY)), Sleeps())
    assert cached(tmp_path) == [GOOD]


def write_manifest(path: Path, entry: Entry) -> Path:
    doc = {"datasets": [{**entry.__dict__, "release": None, "as_at": None}]}
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def test_main_pulls_and_reports_each_file(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    manifest = write_manifest(tmp_path / "m.json", make_entry())
    cache = tmp_path / "cache"
    code = main(
        ["--manifest", str(manifest), "--cache", str(cache)],
        FakeOpener(FakeResponse(BODY)),
        Sleeps(),
    )
    assert code == 0
    assert capsys.readouterr().out == f"demo {cache / GOOD}\n"


def test_main_fails_with_a_message_on_a_bad_digest(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    manifest = write_manifest(tmp_path / "m.json", make_entry())
    cache = tmp_path / "cache"
    code = main(
        ["--manifest", str(manifest), "--cache", str(cache)],
        FakeOpener(FakeResponse(b"x")),
        Sleeps(),
    )
    assert code == 1
    assert "pull failed" in capsys.readouterr().err
    assert list(cache.iterdir()) == []


def test_main_reports_a_bad_manifest(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code = main(
        ["--manifest", str(tmp_path / "none.json")], FakeOpener(FakeResponse(BODY)), Sleeps()
    )
    assert code == 1
    assert "pull failed" in capsys.readouterr().err
    assert MANIFEST_PATH.is_file()
