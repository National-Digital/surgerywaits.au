import json
from pathlib import Path

import pytest

from fakes import FakeOpener, FakeResponse, Sleeps, make_entry
from surgerywaits.manifest import ManifestError, load
from surgerywaits.pull import PullError, pull

ROOT = Path(__file__).resolve().parents[2]


def test_manifest_entry_pins_slug_version_and_sha256() -> None:
    entries = load()
    assert entries
    for e in entries:
        assert e.url == f"https://publicdata.au/d/{e.slug}/v/{e.version}/data.parquet"
        assert len(e.sha256) == 64  # noqa: PLR2004
        assert int(e.sha256, 16) >= 0


def test_download_with_wrong_digest_fails_closed(tmp_path: Path) -> None:
    with pytest.raises(PullError):
        pull((make_entry(),), tmp_path, FakeOpener(FakeResponse(b"wrong")), Sleeps())
    assert list(tmp_path.iterdir()) == []


@pytest.mark.skip(reason="planned: every null carries a publisher marker or is reported")
def test_every_null_has_a_publisher_marker_or_is_reported() -> None:
    raise NotImplementedError


@pytest.mark.skip(reason="planned: every publisher marker maps to a known reason")
def test_every_marker_maps_to_a_known_reason() -> None:
    raise NotImplementedError


@pytest.mark.skip(reason="planned: an unmatched or ambiguous hospital join fails the build")
def test_unmatched_or_ambiguous_hospital_join_fails() -> None:
    raise NotImplementedError


def test_licence_is_on_the_allow_list(tmp_path: Path) -> None:
    assert {e.licence for e in load()} <= {"CC-BY-4.0", "CC-BY-3.0-AU"}
    path = tmp_path / "manifest.json"
    data = json.loads((ROOT / "data" / "manifest.json").read_text(encoding="utf-8"))
    data["datasets"][0]["licence"] = "All-rights-reserved"
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ManifestError):
        load(path)


@pytest.mark.skip(reason="planned: building the pipeline twice gives byte-identical dist")
def test_building_twice_gives_byte_identical_dist() -> None:
    raise NotImplementedError


@pytest.mark.skip(reason="planned: no wall-clock value lands in dist")
def test_no_wall_clock_values_in_dist() -> None:
    raise NotImplementedError


@pytest.mark.skip(reason="planned: the private sector is excluded")
def test_private_sector_is_excluded() -> None:
    raise NotImplementedError


@pytest.mark.skip(reason="planned: coordinates fall within Australia")
def test_coordinates_fall_within_australia() -> None:
    raise NotImplementedError


def test_slugs_are_unique() -> None:
    slugs = [e.slug for e in load()]
    assert len(slugs) == len(set(slugs))
