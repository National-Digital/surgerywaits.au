import json
from dataclasses import replace
from pathlib import Path

import pytest

from fakes import FakeOpener, FakeResponse, Sleeps, make_entry
from surgerywaits.catalogue import Role
from surgerywaits.derive import RankStatus, derive_table
from surgerywaits.hospitals import (
    LATITUDE_RANGE,
    LONGITUDE_RANGE,
    HospitalError,
    Register,
    Row,
    build_register,
    load_register,
    read_rows,
)
from surgerywaits.manifest import ManifestError, load
from surgerywaits.pull import PullError, pull
from surgerywaits.suppression import (
    MARKER_REASONS,
    QLD_VALUE_COLUMNS,
    SuppressionError,
    qld_figures,
    suppress,
)
from surgerywaits.waiting_times import Cell, Observation, Table, WaitingTimes, WaitingTimesError
from surgerywaits.waiting_times import build as build_waiting_times
from surgerywaits.waiting_times import read_rows as read_waiting_rows

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "pipeline" / "tests" / "fixtures"
HOSPITAL_SLUGS = (
    "au-myhospitals-reporting-units",
    "au-myhospitals-reporting-unit-mappings",
    "au-hospitals-myhospitals",
)


def _hospital_rows() -> tuple[list[Row], list[Row], list[Row]]:
    units, mappings, records = (read_rows(FIXTURES / s / "data.parquet") for s in HOSPITAL_SLUGS)
    return units, mappings, records


def _register() -> Register:
    return load_register(*(FIXTURES / s / "data.parquet" for s in HOSPITAL_SLUGS))


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


def _urgency() -> WaitingTimes:
    path = FIXTURES / "au-elective-surgery-waiting-times" / "data.parquet"
    return build_waiting_times(read_waiting_rows(path), Table.URGENCY, _register())


def _with_cell(result: WaitingTimes, **changes: object) -> WaitingTimes:
    first = result.observations[0]
    cell = replace(first.cells[0], **changes)
    edited = replace(first, cells=(cell, *first.cells[1:]))
    return replace(result, observations=(edited, *result.observations[1:]))


def test_every_null_has_a_publisher_marker_or_is_reported() -> None:
    result = _urgency()
    assert suppress(result).observations
    with pytest.raises(SuppressionError, match="null and carries no marker"):
        suppress(_with_cell(result, value=None, marker=None))
    with pytest.raises(SuppressionError, match="sits on a value"):
        suppress(_with_cell(result, value=7, marker="NP"))
    row: dict[str, object] = dict.fromkeys(QLD_VALUE_COLUMNS, 1)
    row["suppressed"] = []
    row["treated"] = None
    with pytest.raises(SuppressionError, match="not flagged"):
        qld_figures(row)


def test_every_marker_maps_to_a_known_reason() -> None:
    result = _urgency()
    seen = {c.marker for o in result.observations for c in o.cells if c.marker}
    assert seen <= set(MARKER_REASONS)
    with pytest.raises(SuppressionError, match="unknown marker 'X9'"):
        suppress(_with_cell(result, value=None, marker="X9"))


def test_unmatched_or_ambiguous_hospital_join_fails() -> None:
    register = _register()
    rows = read_waiting_rows(FIXTURES / "au-elective-surgery-waiting-times" / "data.parquet")
    assert build_waiting_times(rows, Table.URGENCY, register).observations
    renamed = [
        {**r, "reporting_unit": "Armidale Health Service"}
        if r["reporting_unit"] == "Armidale Hospital"
        else r
        for r in rows
    ]
    with pytest.raises(WaitingTimesError, match="unmatched"):
        build_waiting_times(renamed, Table.URGENCY, register)
    twin = next(h for h in register.hospitals if h.name == "Manly Hospital")
    twins = tuple(
        replace(h, name=twin.name) if h.name == "Armidale Hospital" else h
        for h in register.hospitals
    )
    with pytest.raises(WaitingTimesError, match="ambiguous"):
        build_waiting_times(rows, Table.URGENCY, replace(register, hospitals=twins))


def test_licence_is_on_the_allow_list(tmp_path: Path) -> None:
    assert {e.licence for e in load()} <= {"CC-BY-4.0", "CC-BY-3.0-AU"}
    path = tmp_path / "manifest.json"
    data = json.loads((ROOT / "data" / "manifest.json").read_text(encoding="utf-8"))
    data["datasets"][0]["licence"] = "All-rights-reserved"
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ManifestError):
        load(path)


def test_no_ranking_uses_suppressed_or_stale_rows() -> None:
    def obs(code: str, period: str, median: int | None) -> Observation:
        cell = Cell("median_wait_days", Role.MEDIAN_WAIT, median, None if median else "NP")
        return Observation(code, code, "name", period, "Urgent", None, (cell,))

    now, before = "2024\u201325", "2023\u201324"
    table = suppress(
        WaitingTimes(
            Table.URGENCY,
            (
                obs("OK", now, 50),
                obs("HIDDEN", now, None),
                obs("SHUT", now, 1),
                obs("STALE", before, 2),
                obs("OK", before, 3),
            ),
            (),
        )
    )
    derived, _ = derive_table(Table.URGENCY, table, frozenset({"SHUT"}))
    status = {(o.code, o.period): (o.figures[0].status, o.figures[0].rank) for o in derived}
    assert status == {
        ("OK", now): (RankStatus.RANKED, 1),
        ("HIDDEN", now): (RankStatus.NOT_PUBLISHED, None),
        ("SHUT", now): (RankStatus.CLOSED, None),
        ("STALE", before): (RankStatus.STALE, None),
        ("OK", before): (RankStatus.EARLIER_PERIOD, None),
    }


@pytest.mark.skip(reason="planned: building the pipeline twice gives byte-identical dist")
def test_building_twice_gives_byte_identical_dist() -> None:
    raise NotImplementedError


@pytest.mark.skip(reason="planned: no wall-clock value lands in dist")
def test_no_wall_clock_values_in_dist() -> None:
    raise NotImplementedError


def test_private_sector_is_excluded() -> None:
    units, mappings, records = _hospital_rows()
    assert not any(
        u["private"] for u in units if u["code"] in {h.code for h in _register().hospitals}
    )
    units = [{**u, "private": True} if u["code"] == "H0075" else u for u in units]
    records = [{**r, "sector": "Private"} if r["code"] == "H0075" else r for r in records]
    register = build_register(units, mappings, records)
    assert "H0075" not in {h.code for h in register.hospitals}
    assert register.excluded_private == ("H0075",)


def test_coordinates_fall_within_australia() -> None:
    lat_low, lat_high = LATITUDE_RANGE
    lon_low, lon_high = LONGITUDE_RANGE
    for h in _register().hospitals:
        if h.latitude is not None and h.longitude is not None:
            assert lat_low <= h.latitude <= lat_high, h.code
            assert lon_low <= h.longitude <= lon_high, h.code
    units, mappings, records = _hospital_rows()
    bad = [{**r, "latitude": 37.5} if r["code"] == "H0075" else r for r in records]
    with pytest.raises(HospitalError):
        build_register(units, mappings, bad)


def test_slugs_are_unique() -> None:
    slugs = [e.slug for e in load()]
    assert len(slugs) == len(set(slugs))
