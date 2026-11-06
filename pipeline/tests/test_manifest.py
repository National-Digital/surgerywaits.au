import copy
import json
from pathlib import Path
from typing import Any

import pytest

from surgerywaits.manifest import MANIFEST_PATH, SCHEMA_PATH, ManifestError, load

FIXTURES = Path(__file__).parent / "fixtures" / "manifest.json"
DIGEST = "a" * 64


def entry(slug: str = "demo", version: str = "2026-01-02", **over: Any) -> dict[str, Any]:  # noqa: ANN401
    base: dict[str, Any] = {
        "slug": slug,
        "version": version,
        "release": None,
        "as_at": None,
        "licence": "CC-BY-4.0",
        "attribution": "A publisher.",
        "citation": "A publisher. Versioned at publicdata.au.",
        "url": f"https://publicdata.au/d/{slug}/v/{version}/data.parquet",
        "sha256": DIGEST,
    }
    return base | over


def write(tmp_path: Path, *entries: dict[str, Any]) -> Path:
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps({"datasets": list(entries)}), encoding="utf-8")
    return path


def test_the_real_manifest_validates_against_the_schema() -> None:
    entries = load(MANIFEST_PATH, SCHEMA_PATH)
    assert len(entries) == 10  # noqa: PLR2004


def test_every_entry_matches_the_fixture_manifest() -> None:
    fixture = json.loads(FIXTURES.read_text(encoding="utf-8"))
    entries = {e.slug: e for e in load()}
    assert set(entries) == set(fixture)
    for slug, pin in fixture.items():
        assert entries[slug].version == pin["version"]
        assert entries[slug].sha256 == pin["source_sha256"]
        assert entries[slug].url == pin["source_url"]
        assert entries[slug].licence == pin["licence"]


def test_a_valid_entry_loads(tmp_path: Path) -> None:
    (loaded,) = load(write(tmp_path, entry(release="2026010101", as_at="2026-01-01")))
    assert (loaded.slug, loaded.release, loaded.as_at) == ("demo", "2026010101", "2026-01-01")


def test_a_licence_outside_the_allow_list_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ManifestError, match="licence"):
        load(write(tmp_path, entry(licence="CC0-1.0")))


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/d/demo/v/2026-01-02/data.parquet",
        "http://publicdata.au/d/demo/v/2026-01-02/data.parquet",
        "https://publicdata.au/d/demo/v/latest/data.parquet",
        "https://publicdata.au/d/demo/v/2026-01-02/data.csv",
        "https://publicdata.au.evil.example/d/demo/v/2026-01-02/data.parquet",
    ],
)
def test_a_url_outside_the_version_file_form_is_rejected(tmp_path: Path, url: str) -> None:
    with pytest.raises(ManifestError, match="url"):
        load(write(tmp_path, entry(url=url)))


def test_a_url_naming_another_slug_or_version_is_rejected(tmp_path: Path) -> None:
    other = "https://publicdata.au/d/other/v/2026-01-02/data.parquet"
    with pytest.raises(ManifestError, match="own slug and version"):
        load(write(tmp_path, entry(url=other)))


def test_a_duplicate_slug_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ManifestError, match="duplicate slug: demo"):
        load(write(tmp_path, entry(), entry(version="2026-02-03")))


@pytest.mark.parametrize("sha256", ["a" * 63, "a" * 65, "A" * 64, "g" * 64, "", "a" * 64 + "\n"])
def test_a_malformed_sha256_is_rejected(tmp_path: Path, sha256: str) -> None:
    with pytest.raises(ManifestError, match="sha256"):
        load(write(tmp_path, entry(sha256=sha256)))


def test_an_unknown_field_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ManifestError, match="Additional"):
        load(write(tmp_path, entry(extra="x")))


def test_a_missing_field_is_rejected(tmp_path: Path) -> None:
    bad = copy.deepcopy(entry())
    del bad["citation"]
    with pytest.raises(ManifestError, match="citation"):
        load(write(tmp_path, bad))


def test_an_unreadable_manifest_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ManifestError, match="cannot read"):
        load(tmp_path / "missing.json")


@pytest.mark.parametrize("field", ["slug", "version", "as_at", "url"])
def test_a_trailing_newline_is_rejected(tmp_path: Path, field: str) -> None:
    good = entry(as_at="2026-01-01")
    with pytest.raises(ManifestError, match=field):
        load(write(tmp_path, good | {field: good[field] + "\n"}))


@pytest.mark.parametrize("field", ["version", "as_at"])
def test_an_impossible_date_is_rejected(tmp_path: Path, field: str) -> None:
    over = {field: "2026-02-31"}
    if field == "version":
        over["url"] = "https://publicdata.au/d/demo/v/2026-02-31/data.parquet"
    with pytest.raises(ManifestError, match="calendar date"):
        load(write(tmp_path, entry(**over)))
