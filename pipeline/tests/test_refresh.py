import hashlib
import json
import urllib.request
from importlib import import_module
from pathlib import Path
from typing import Any

import pytest

from fakes import FakeResponse
from surgerywaits.manifest import MANIFEST_PATH, load
from surgerywaits.refresh import RefreshError, main, newest_version, refresh, render, summary

# pyarrow ships no type stubs, so it is loaded the way metadata.py loads it.
PA: Any = import_module("pyarrow")
PQ: Any = import_module("pyarrow.parquet")

SLUG = "au-myhospitals-reporting-units"
OLD = "2026-10-27"
NEW = "2026-11-03"


def version_url(version: str) -> str:
    return f"https://publicdata.au/d/{SLUG}/v/{version}/data.parquet"


def parquet(tmp: Path, version: str, **changes: Any) -> bytes:  # noqa: ANN401
    meta: dict[str, Any] = {
        "dataset": SLUG,
        "version": version,
        "url": version_url(version),
        "title": "Reporting units",
        "as_at": None,
        "release": "2026110301",
        "publisher": {"name": "A publisher", "url": "https://publisher.example/"},
        "licence": {"id": "CC-BY-4.0"},
        "attribution": "Credit.",
        "cite": f"Credit. https://publicdata.au/d/{SLUG}/v/{version}/",
        **changes,
    }
    path = tmp / "f.parquet"
    PQ.write_table(
        PA.table({"a": [1]}).replace_schema_metadata({b"publicdata": json.dumps(meta).encode()}),
        path,
    )
    return path.read_bytes()


class Site:
    """Answers each publicdata.au address from a table and records what was asked."""

    def __init__(self, pages: dict[str, bytes]) -> None:
        self.pages = pages
        self.asked: list[str] = []

    def __call__(self, request: urllib.request.Request) -> FakeResponse:
        self.asked.append(request.full_url)
        return FakeResponse(self.pages[request.full_url])


def listing(*versions: str, dataset: str = SLUG) -> bytes:
    body = {"dataset": dataset, "versions": [{"version": v} for v in versions]}
    return json.dumps(body).encode()


def versions_url(slug: str = SLUG) -> str:
    return f"https://publicdata.au/api/v1/datasets/{slug}/versions"


def copy_manifest(tmp: Path) -> Path:
    path = tmp / "manifest.json"
    path.write_bytes(MANIFEST_PATH.read_bytes())
    return path


def site_for_all(tmp: Path, newest: str = NEW) -> Site:
    """Every pinned dataset lists only its own version, except the one that has a newer one."""
    pages: dict[str, bytes] = {}
    for e in load():
        pages[versions_url(e.slug)] = listing(e.version, dataset=e.slug)
    pages[versions_url()] = listing(OLD, newest)
    pages[version_url(NEW)] = parquet(tmp, NEW)
    return Site(pages)


def test_the_committed_manifest_is_what_the_writer_renders() -> None:
    assert render(load()) == MANIFEST_PATH.read_text("utf-8")


def test_the_newest_listed_version_wins_whatever_the_order() -> None:
    site = Site({versions_url(): listing("2026-11-03", "2026-10-27", "2026-09-01")})
    assert newest_version(SLUG, site) == "2026-11-03"


@pytest.mark.parametrize(
    "body",
    [
        b"not json",
        b'{"dataset": "x"}',
        listing(),
        listing("2026-13-45"),
        listing("20261103"),
        listing("2026-11-03T00:00"),
        listing(OLD, dataset="y"),
    ],
)
def test_an_unreadable_listing_fails(body: bytes) -> None:
    with pytest.raises(RefreshError):
        newest_version(SLUG, Site({versions_url(): body}))


def test_a_newer_version_is_pinned_with_the_digest_of_what_was_served(tmp_path: Path) -> None:
    manifest = copy_manifest(tmp_path)
    site = site_for_all(tmp_path)
    moved = refresh(manifest, site)
    assert [(o.slug, o.version, n.version) for o, n in moved] == [(SLUG, OLD, NEW)]
    pinned = {e.slug: e for e in load(manifest)}[SLUG]
    assert pinned.sha256 == hashlib.sha256(site.pages[version_url(NEW)]).hexdigest()
    assert pinned.url == version_url(NEW)
    assert pinned.dataset_url == f"https://publicdata.au/d/{SLUG}/v/{NEW}/"
    assert (pinned.release, pinned.as_at, pinned.title) == ("2026110301", None, "Reporting units")
    assert summary(moved) == f"- `{SLUG}`: {OLD} to {NEW}\n"


def test_every_other_pin_is_left_as_it_was(tmp_path: Path) -> None:
    manifest = copy_manifest(tmp_path)
    before = {e.slug: e for e in load(manifest)}
    refresh(manifest, site_for_all(tmp_path))
    after = {e.slug: e for e in load(manifest)}
    assert {s for s in before if before[s] != after[s]} == {SLUG}
    assert list(before) == list(after)


def test_nothing_changes_when_every_pin_is_the_newest(tmp_path: Path) -> None:
    manifest = copy_manifest(tmp_path)
    before = manifest.read_bytes()
    assert refresh(manifest, site_for_all(tmp_path, newest=OLD)) == []
    assert manifest.read_bytes() == before


def test_a_file_whose_metadata_names_another_version_fails_and_changes_nothing(
    tmp_path: Path,
) -> None:
    manifest = copy_manifest(tmp_path)
    before = manifest.read_bytes()
    site = site_for_all(tmp_path)
    site.pages[version_url(NEW)] = parquet(tmp_path, OLD)
    with pytest.raises(RefreshError, match="another dataset, version or address"):
        refresh(manifest, site)
    assert manifest.read_bytes() == before


def test_a_file_without_a_licence_fails(tmp_path: Path) -> None:
    site = site_for_all(tmp_path)
    site.pages[version_url(NEW)] = parquet(tmp_path, NEW, licence=None)
    with pytest.raises(RefreshError, match="lacks licence"):
        refresh(copy_manifest(tmp_path), site)


def test_a_licence_off_the_allow_list_is_refused_before_the_manifest_is_replaced(
    tmp_path: Path,
) -> None:
    manifest = copy_manifest(tmp_path)
    before = manifest.read_bytes()
    site = site_for_all(tmp_path)
    site.pages[version_url(NEW)] = parquet(tmp_path, NEW, licence={"id": "CC-BY-NC-4.0"})
    with pytest.raises(Exception, match="licence"):
        refresh(manifest, site)
    assert manifest.read_bytes() == before
    assert not (tmp_path / "manifest.json.new").exists()


def test_main_reports_a_failure_and_writes_the_summary(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    manifest = copy_manifest(tmp_path)
    out = tmp_path / "summary.md"
    argv = ["--manifest", str(manifest), "--summary", str(out)]
    assert main(argv, site_for_all(tmp_path)) == 0
    assert out.read_text("utf-8") == f"- `{SLUG}`: {OLD} to {NEW}\n"
    broken = Site({versions_url(e.slug): b"{}" for e in load()})
    assert main(["--manifest", str(manifest)], broken) == 1
    assert "refresh failed" in capsys.readouterr().err
