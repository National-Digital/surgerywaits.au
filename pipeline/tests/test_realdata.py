from pathlib import Path

import pytest

import realdata
from surgerywaits.manifest import load

ENTRY = load()[0]


def test_a_missing_pinned_file_skips_by_default(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(realdata, "CACHE_DIR", tmp_path)
    monkeypatch.delenv(realdata.REQUIRE_ENV, raising=False)
    with pytest.raises(pytest.skip.Exception):
        realdata.pinned(ENTRY.slug)


def test_a_missing_pinned_file_fails_when_data_is_required(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(realdata, "CACHE_DIR", tmp_path)
    monkeypatch.setenv(realdata.REQUIRE_ENV, "1")
    with pytest.raises(pytest.fail.Exception, match=ENTRY.slug):
        realdata.pinned(ENTRY.slug)


def test_a_cached_pinned_file_is_returned(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    (tmp_path / ENTRY.sha256).write_bytes(b"x")
    monkeypatch.setattr(realdata, "CACHE_DIR", tmp_path)
    monkeypatch.setenv(realdata.REQUIRE_ENV, "1")
    assert realdata.pinned(ENTRY.slug) == [tmp_path / ENTRY.sha256]


def test_an_unplanned_skip_fails_when_data_is_required(
    pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch
) -> None:
    pytester.makeconftest((Path(__file__).parent / "conftest.py").read_text("utf-8"))
    pytester.makepyfile(
        """
        import pytest

        def test_unplanned():
            pytest.skip("not cached")

        @pytest.mark.skip(reason="planned: later")
        def test_planned():
            pass
        """
    )
    monkeypatch.delenv(realdata.REQUIRE_ENV, raising=False)
    pytester.runpytest_inprocess().assert_outcomes(skipped=2)
    monkeypatch.setenv(realdata.REQUIRE_ENV, "1")
    pytester.runpytest_inprocess().assert_outcomes(failed=1, skipped=1)


@pytest.mark.parametrize(
    "body",
    [
        'import pytest\npytest.skip("not cached", allow_module_level=True)',
        'import pytest\npytest.importorskip("no_such_module_here")',
    ],
    ids=["module-level skip", "importorskip"],
)
def test_an_unplanned_collection_skip_fails_when_data_is_required(
    pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch, body: str
) -> None:
    pytester.makeconftest((Path(__file__).parent / "conftest.py").read_text("utf-8"))
    pytester.makepyfile(f"{body}\n\ndef test_x():\n    pass\n")
    monkeypatch.delenv(realdata.REQUIRE_ENV, raising=False)
    pytester.runpytest_inprocess().assert_outcomes(skipped=1)
    monkeypatch.setenv(realdata.REQUIRE_ENV, "1")
    pytester.runpytest_inprocess().assert_outcomes(errors=1)


def test_a_planned_collection_skip_passes_when_data_is_required(
    pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch
) -> None:
    pytester.makeconftest((Path(__file__).parent / "conftest.py").read_text("utf-8"))
    pytester.makepyfile('import pytest\npytest.skip("planned: later", allow_module_level=True)\n')
    monkeypatch.setenv(realdata.REQUIRE_ENV, "1")
    pytester.runpytest_inprocess().assert_outcomes(skipped=1)
