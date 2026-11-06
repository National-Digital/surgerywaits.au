from pathlib import Path

import pytest

from surgerywaits.hospitals import (
    HospitalError,
    Register,
    Row,
    build_register,
    load_register,
    read_rows,
)
from surgerywaits.manifest import load
from surgerywaits.pull import CACHE_DIR

FIXTURES = Path(__file__).resolve().parent / "fixtures"
REGISTER_SLUGS = (
    "au-myhospitals-reporting-units",
    "au-myhospitals-reporting-unit-mappings",
    "au-hospitals-myhospitals",
)


def _fixture_register() -> Register:
    units, mappings, records = _rows()
    return build_register(units, mappings, records)


def _path(slug: str) -> Path:
    return FIXTURES / slug / "data.parquet"


def _rows() -> tuple[list[Row], list[Row], list[Row]]:
    return (
        read_rows(_path("au-myhospitals-reporting-units")),
        read_rows(_path("au-myhospitals-reporting-unit-mappings")),
        read_rows(_path("au-hospitals-myhospitals")),
    )


def _edit(rows: list[Row], code: str, key: str, value: object, code_key: str = "code") -> list[Row]:
    return [{**r, key: value} if r[code_key] == code else r for r in rows]


def _unit(code: str, name: str, alternatives: str | None = None) -> Row:
    return {
        "code": code,
        "name": name,
        "type_code": "H",
        "alternative_names": alternatives,
        "private": False,
        "closed": False,
    }


def _record(code: str, name: str, state: str = "Victoria") -> Row:
    return {
        "code": code,
        "name": name,
        "type": "Hospital",
        "sector": "Public",
        "open_closed": "Open",
        "state": state,
        "latitude": -37.8,
        "longitude": 145.0,
        "local_hospital_network": None,
    }


def _state(code: str, state: str = "Vic") -> Row:
    return {
        "reporting_unit_code": code,
        "map_type_code": "STATE_MAPPING",
        "mapped_code": state,
        "mapped_name": "x",
    }


def test_the_fixtures_build_the_register() -> None:
    register = load_register(
        _path("au-myhospitals-reporting-units"),
        _path("au-myhospitals-reporting-unit-mappings"),
        _path("au-hospitals-myhospitals"),
    )
    by_code = {h.code: h for h in register.hospitals}
    assert len(by_code) == 12  # noqa: PLR2004
    assert [h.code for h in register.hospitals] == sorted(by_code)
    assert {c for c, h in by_code.items() if h.closed} == {"H0066", "H0389"}
    assert register.excluded_private == ()
    armidale = by_code["H0075"]
    assert (armidale.state, armidale.network_name) == ("NSW", "Hunter New England")
    assert (armidale.latitude, armidale.longitude) == (-30.512726, 151.655629)
    assert by_code["H0389"].alternative_names == ("RCH", "Royal Children's QLD")
    assert by_code["H0340"].alternative_names == ()
    assert by_code["H0066"].latitude is None
    assert by_code["H0066"].network_name is None
    assert by_code["H0385"].network_code is None
    assert by_code["H0066"].network_status == "unmapped"
    assert by_code["H0385"].network_status == "not_applicable"
    assert armidale.network_status == "mapped"


def test_a_private_hospital_is_excluded_and_listed() -> None:
    units, mappings, records = _rows()
    units = _edit(units, "H0075", "private", value=True)
    records = _edit(records, "H0075", "sector", "Private")
    register = build_register(units, mappings, records)
    assert register.excluded_private == ("H0075",)
    assert "H0075" not in {h.code for h in register.hospitals}
    assert len(register.hospitals) == 11  # noqa: PLR2004


def test_duplicate_codes_fail_closed() -> None:
    units, mappings, records = _rows()
    with pytest.raises(HospitalError, match="duplicate code H0075"):
        build_register([*units, units[1]], mappings, records)
    with pytest.raises(HospitalError, match="duplicate code H0075"):
        build_register(units, mappings, [*records, records[1]])


def test_a_mapping_to_a_missing_unit_fails_closed() -> None:
    units, mappings, records = _rows()
    stray = {**mappings[0], "reporting_unit_code": "H9999"}
    with pytest.raises(HospitalError, match="H9999 points to a unit"):
        build_register(units, [*mappings, stray], records)


@pytest.mark.parametrize(
    ("key", "value"),
    [("latitude", 37.5), ("latitude", -91.0), ("longitude", 15.0), ("longitude", -151.6)],
)
def test_a_coordinate_outside_australia_fails_closed(key: str, value: float) -> None:
    units, mappings, records = _rows()
    with pytest.raises(HospitalError, match="outside Australia"):
        build_register(units, mappings, _edit(records, "H0075", key, value))


def test_half_a_coordinate_pair_fails_closed() -> None:
    units, mappings, records = _rows()
    with pytest.raises(HospitalError, match="only one of"):
        build_register(units, mappings, _edit(records, "H0075", "longitude", None))


def test_an_unknown_sector_fails_closed() -> None:
    units, mappings, records = _rows()
    with pytest.raises(HospitalError, match="unknown sector 'Mixed'"):
        build_register(units, mappings, _edit(records, "H0075", "sector", "Mixed"))


def test_an_unknown_state_fails_closed() -> None:
    units, mappings, records = _rows()
    odd = _edit(mappings, "H0075", "mapped_code", "XX", "reporting_unit_code")
    with pytest.raises(HospitalError, match="unknown state"):
        build_register(units, [*odd], records)


def test_a_missing_state_mapping_fails_closed() -> None:
    units, mappings, records = _rows()
    kept = [
        m
        for m in mappings
        if not (m["reporting_unit_code"] == "H0075" and m["map_type_code"] == "STATE_MAPPING")
    ]
    with pytest.raises(HospitalError, match="no state mapping"):
        build_register(units, kept, records)


def test_sources_that_disagree_fail_closed() -> None:
    units, mappings, records = _rows()
    with pytest.raises(HospitalError, match="closed flag disagrees"):
        build_register(_edit(units, "H0075", "closed", value=True), mappings, records)
    with pytest.raises(HospitalError, match="sector disagrees"):
        build_register(_edit(units, "H0075", "private", value=True), mappings, records)
    with pytest.raises(HospitalError, match="state disagrees"):
        build_register(units, mappings, _edit(records, "H0075", "state", "Victoria"))
    with pytest.raises(HospitalError, match="network disagrees"):
        build_register(units, mappings, _edit(records, "H0075", "local_hospital_network", "Other"))


def test_a_hospital_missing_from_one_dataset_fails_closed() -> None:
    units, mappings, records = _rows()
    with pytest.raises(HospitalError, match="H0075"):
        build_register(units, mappings, [r for r in records if r["code"] != "H0075"])


def test_an_alternative_name_equal_to_another_hospitals_name_fails_closed() -> None:
    mappings = [_state("A1"), _state("A2")]
    units = [_unit("A1", "Alpha Hospital"), _unit("A2", "Beta Hospital", "alpha hospital")]
    records = [_record("A1", "Alpha Hospital"), _record("A2", "Beta Hospital")]
    with pytest.raises(HospitalError, match="is the name of A1 in Vic"):
        build_register(units, mappings, records)


def test_an_alias_shared_by_hospitals_in_one_state_is_kept_and_listed() -> None:
    register = _fixture_register()
    (shared,) = register.shared_aliases
    assert (shared.state, shared.alias) == ("Vic", "WDHS")
    assert [h.name for h in register.hospitals if h.code in shared.codes] == [
        "Western District Health Service [Hamilton]",
        "Western District Health Service [Penshurst]",
    ]
    mappings = [_state("A1"), _state("A2")]
    units = [_unit("A1", "Alpha", "Town"), _unit("A2", "Beta", "town")]
    records = [_record("A1", "Alpha"), _record("A2", "Beta")]
    (alias,) = build_register(units, mappings, records).shared_aliases
    assert alias.codes == ("A1", "A2")


def test_the_same_alternative_name_in_two_states_is_not_shared() -> None:
    mappings = [_state("A1"), _state("A2", "Qld")]
    units = [_unit("A1", "Alpha", "Town"), _unit("A2", "Beta", "Town")]
    records = [_record("A1", "Alpha"), _record("A2", "Beta", "Queensland")]
    register = build_register(units, mappings, records)
    assert len(register.hospitals) == 2  # noqa: PLR2004
    assert register.shared_aliases == ()


def test_non_hospital_rows_and_their_duplicate_mappings_are_ignored() -> None:
    units, mappings, records = _rows()
    assert {r["type"] for r in records} > {"Hospital", "Local Hospital Network", "State"}
    pairs = [(m["reporting_unit_code"], m["map_type_code"], m["mapped_code"]) for m in mappings]
    assert ("NSW", "STATE_MAPPING", "NSW") in {p for p in pairs if pairs.count(p) > 1}
    assert len(build_register(units, mappings, records).hospitals) == 12  # noqa: PLR2004


def test_a_duplicate_mapping_for_a_hospital_fails_closed() -> None:
    units, mappings, records = _rows()
    dup = next(m for m in mappings if m["reporting_unit_code"] == "H0075")
    with pytest.raises(HospitalError, match="more than one"):
        build_register(units, [*mappings, dup], records)


def _pulled(slug: str) -> Path | None:
    entry = next(e for e in load() if e.slug == slug)
    path = CACHE_DIR / entry.sha256
    return path if path.is_file() else None


def test_the_full_register_at_the_pinned_versions() -> None:
    paths = [_pulled(s) for s in REGISTER_SLUGS]
    if None in paths:
        pytest.skip("the pinned files are not in pipeline/.downloads")
    units, mappings, records = (p for p in paths if p is not None)
    register = load_register(units, mappings, records)
    assert len(register.hospitals) + len(register.excluded_private) == 1166  # noqa: PLR2004
    assert len(register.hospitals) == 714  # noqa: PLR2004
    assert len(register.excluded_private) == 452  # noqa: PLR2004
