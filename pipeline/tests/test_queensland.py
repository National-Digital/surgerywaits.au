import ast
import dataclasses
from datetime import date
from pathlib import Path

import pytest

from realdata import pinned
from surgerywaits import queensland
from surgerywaits.hospitals import Hospital, Register, Row, load_register
from surgerywaits.queensland import (
    OVERRIDES,
    SPECIALTIES,
    MatchedBy,
    Overlay,
    Override,
    Quarter,
    QueenslandError,
    build_overlay,
    load_overlay,
    map_facilities,
    map_specialties,
    parse_quarter,
)
from surgerywaits.suppression import QLD_VALUE_COLUMNS, FigureState, Reason

FIXTURES = Path(__file__).resolve().parent / "fixtures"
REGISTER_SLUGS = (
    "au-myhospitals-reporting-units",
    "au-myhospitals-reporting-unit-mappings",
    "au-hospitals-myhospitals",
)
BY_CATEGORY = "qld-elective-surgery-by-category"
BY_SPECIALTY = "qld-elective-surgery-by-specialty"
SEP_25 = Quarter(2025, 3)


def _hospital(
    code: str,
    name: str,
    *,
    state: str = "Qld",
    alternatives: tuple[str, ...] = (),
    closed: bool = False,
) -> Hospital:
    return Hospital(code, name, alternatives, state, None, None, closed, None, None, "unmapped")


def _row(facility_code: str, facility: str, key: str, value: str, **changes: object) -> Row:
    figures: dict[str, object] = dict.fromkeys(QLD_VALUE_COLUMNS, 5)
    base: dict[str, object] = {
        "facility_code": facility_code,
        "facility": facility,
        "report_month": "Sep-25",
        "suppressed": [],
        "data_last_update": date(2025, 10, 28),
        **figures,
        key: value,
    }
    if key == "specialty_code":
        base["specialty_desc"] = "ALL" if value == "ALL" else _desc(value)
    return {**base, **changes}


def _desc(code: str) -> str:
    return next(s.source_name for s in SPECIALTIES if s.code == code)


def _rows(code: str = "191", name: str = "Ayr") -> tuple[list[Row], list[Row]]:
    categories = [_row(code, name, "category", c) for c in ("1", "2", "3", "ALL")]
    specialties = [_row(code, name, "specialty_code", c) for c in ("ALL", "3")]
    return categories, specialties


AYR = _hospital("H0482", "Ayr Hospital")


def _fixture_register() -> Register:
    return load_register(*(FIXTURES / s / "data.parquet" for s in REGISTER_SLUGS))


def _fixture_overlay() -> Overlay:
    return load_overlay(
        FIXTURES / BY_CATEGORY / "data.parquet",
        FIXTURES / BY_SPECIALTY / "data.parquet",
        _fixture_register(),
    )


def test_a_quarter_is_read_from_its_last_month() -> None:
    quarter = parse_quarter("Sep-25")
    assert quarter == SEP_25
    assert quarter.end == date(2025, 9, 30)
    assert quarter.reference_period == "July to September 2025"
    with pytest.raises(QueenslandError, match="last month of a quarter"):
        parse_quarter("Oct-25")


def test_a_facility_matches_the_one_hospital_that_carries_its_name() -> None:
    hospitals = [
        AYR,
        _hospital("H0450", "Prince Charles Hospital", alternatives=("Prince Charles",)),
    ]
    result = map_facilities({"191": "Ayr", "4": "Prince Charles"}, hospitals)
    assert [(m.facility_code, m.hospital_code, m.matched_by) for m in result.matches] == [
        ("191", "H0482", MatchedBy.NAME),
        ("4", "H0450", MatchedBy.NAME),
    ]


def test_a_facility_no_hospital_carries_is_left_out_with_its_reason() -> None:
    result = map_facilities({"346": "Noosa"}, [AYR])
    assert result.matches == ()
    assert [(u.facility_name, u.reason) for u in result.unmapped] == [
        ("Noosa", "no public hospital in the national register carries this name")
    ]


def test_an_ambiguous_facility_is_left_out_naming_both_hospitals() -> None:
    hospitals = [
        _hospital("H0489", "Townsville University Hospital"),
        _hospital("H0536", "Kirwan Rehabilitation Unit", alternatives=("Townsville",)),
    ]
    result = map_facilities({"200": "Townsville"}, hospitals, overrides={})
    assert result.matches == ()
    assert result.unmapped[0].reason == (
        "more than one national hospital carries this name: H0489, H0536"
    )


def test_an_override_settles_an_ambiguous_facility() -> None:
    hospitals = [
        _hospital("H0489", "Townsville University Hospital"),
        _hospital("H0536", "Kirwan Rehabilitation Unit", alternatives=("Townsville",)),
    ]
    (match,) = map_facilities({"200": "Townsville"}, hospitals).matches
    assert (match.hospital_code, match.matched_by) == ("H0489", MatchedBy.OVERRIDE)


def test_an_override_stops_the_build_when_either_side_is_renamed() -> None:
    hospital = _hospital("H0489", "Townsville University Hospital")
    with pytest.raises(QueenslandError, match="override for facility 200"):
        map_facilities({"200": "Townsville City"}, [hospital])
    with pytest.raises(QueenslandError, match="override for facility 200"):
        map_facilities({"200": "Townsville"}, [_hospital("H0489", "Townsville Hospital")])
    with pytest.raises(QueenslandError, match="override for facility 200"):
        map_facilities({"200": "Townsville"}, [])


def test_the_override_table_is_small_and_names_each_hospital_once() -> None:
    assert sorted(OVERRIDES) == ["120", "200", "22", "33"]
    codes = [o.hospital_code for o in OVERRIDES.values()]
    assert len(set(codes)) == len(codes)
    assert all(isinstance(o, Override) for o in OVERRIDES.values())


def test_two_facilities_for_one_hospital_are_both_left_out() -> None:
    hospitals = [_hospital("H0001", "Alpha Hospital", alternatives=("Beta",))]
    result = map_facilities({"1": "Alpha", "2": "Beta"}, hospitals)
    assert result.matches == ()
    assert {u.reason for u in result.unmapped} == {
        "another facility maps to the same hospital H0001"
    }


def test_a_closed_hospital_or_one_in_another_state_is_never_matched() -> None:
    hospitals = [
        _hospital("H0001", "Alpha Hospital", closed=True),
        _hospital("H0002", "Beta Hospital", state="NSW"),
    ]
    result = map_facilities({"1": "Alpha", "2": "Beta"}, hospitals)
    assert result.matches == ()
    assert [u.reason for u in result.unmapped] == [
        "the national register lists H0001 as closed",
        "no public hospital in the national register carries this name",
    ]


def test_the_state_total_is_not_a_facility() -> None:
    result = map_facilities({"99999": "Queensland Reporting Hospitals"}, [AYR])
    assert result.unmapped == ()
    assert [n.facility_code for n in result.not_facilities] == ["99999"]


def test_every_mapped_specialty_is_named_as_the_release_names_it() -> None:
    _, specialties = _rows()
    assert [s.code for s in map_specialties(specialties)] == ["3"]
    assert len({s.slug for s in SPECIALTIES}) == len(SPECIALTIES)


def test_a_specialty_the_map_does_not_cover_fails() -> None:
    with pytest.raises(QueenslandError, match=r"specialty 12: \['vascular surgery'\]"):
        map_specialties(
            [
                _row(
                    "1",
                    "A",
                    "specialty_code",
                    "3",
                    specialty_code="12",
                    specialty_desc="vascular surgery",
                )
            ]
        )


def test_a_renamed_specialty_fails() -> None:
    with pytest.raises(QueenslandError, match="specialty 3"):
        map_specialties(
            [_row("1", "A", "specialty_code", "3", specialty_desc="general surgery (adult)")]
        )


def test_an_ambiguous_specialty_fails() -> None:
    rows = [
        _row("1", "A", "specialty_code", "3"),
        _row("2", "B", "specialty_code", "3", specialty_desc="other"),
    ]
    with pytest.raises(QueenslandError, match="specialty 3"):
        map_specialties(rows)


def test_a_facility_published_under_two_names_fails() -> None:
    categories, specialties = _rows()
    specialties[0] = {**specialties[0], "facility": "Ayr Base"}
    with pytest.raises(QueenslandError, match="published as both"):
        build_overlay(categories, specialties, [AYR])


def test_a_figure_state_comes_from_the_suppression_mapping() -> None:
    categories, specialties = _rows()
    categories[0] = {**categories[0], "waiting": None, "suppressed": ["waiting"]}
    categories[1] = {**categories[1], "percent_change_treated_on_prior_year": None}
    categories[2] = {**categories[2], "treated": 0}
    (record,) = build_overlay(categories, specialties, [AYR]).records
    first, second, third = (c.figures for c in record.categories)
    waiting = next(f for f in first if f.column == "waiting")
    assert (waiting.state, waiting.value, waiting.reason) == (
        FigureState.NOT_PUBLISHED,
        None,
        Reason.NOT_GIVEN_BY_QUEENSLAND_HEALTH,
    )
    change = next(f for f in second if f.column == "percent_change_treated_on_prior_year")
    assert (change.state, change.value) == (FigureState.NOT_REPORTED, None)
    treated = next(f for f in third if f.column == "treated")
    assert (treated.state, treated.value) == (FigureState.PUBLISHED, 0)


def test_an_unflagged_null_fails_the_build() -> None:
    categories, specialties = _rows()
    categories[0] = {**categories[0], "waiting": None}
    with pytest.raises(Exception, match="null and not flagged"):
        build_overlay(categories, specialties, [AYR])


def test_the_two_tables_must_agree_on_a_facility_total() -> None:
    categories, specialties = _rows()
    specialties[0] = {**specialties[0], "treated": 6}
    with pytest.raises(QueenslandError, match="disagree on the facility total"):
        build_overlay(categories, specialties, [AYR])


def test_a_missing_total_fails() -> None:
    categories, specialties = _rows()
    with pytest.raises(QueenslandError, match="total row is missing"):
        build_overlay(categories[:3], specialties, [AYR])


def test_a_repeated_row_fails() -> None:
    categories, specialties = _rows()
    with pytest.raises(QueenslandError, match="appears twice"):
        build_overlay([*categories, categories[0]], specialties, [AYR])


def test_an_unknown_urgency_category_fails() -> None:
    categories, specialties = _rows()
    with pytest.raises(QueenslandError, match="unknown urgency categories"):
        build_overlay([*categories, _row("191", "Ayr", "category", "4")], specialties, [AYR])


def test_rows_with_two_release_dates_fail() -> None:
    categories, specialties = _rows()
    categories[0] = {**categories[0], "data_last_update": date(2025, 11, 1)}
    with pytest.raises(QueenslandError, match="2 release dates"):
        build_overlay(categories, specialties, [AYR])


def test_unmapped_facilities_leave_no_records() -> None:
    categories, specialties = _rows("346", "Noosa")
    overlay = build_overlay(categories, specialties, [AYR])
    assert overlay.records == ()
    assert [u.facility_code for u in overlay.facilities.unmapped] == ["346"]


def test_the_fixtures_map_by_name_and_leave_the_rest_out() -> None:
    overlay = _fixture_overlay()
    assert [(m.facility_name, m.hospital_code) for m in overlay.facilities.matches] == [
        ("Mater Adult", "H0385"),
        ("Ayr", "H0482"),
        ("Cooktown", "H0496"),
    ]
    assert sorted(u.facility_name for u in overlay.facilities.unmapped) == [
        "Cairns",
        "Noosa",
        "Thursday Island",
    ]
    assert [n.facility_code for n in overlay.facilities.not_facilities] == ["99999"]
    assert [r.hospital_code for r in overlay.records] == ["H0385", "H0482", "H0496"]
    assert overlay.quarters == (SEP_25,)
    assert all(r.release_date == date(2025, 10, 28) for r in overlay.records)


def test_the_overlay_is_repeatable_and_ordered() -> None:
    first, second = _fixture_overlay(), _fixture_overlay()
    assert first == second
    codes = [r.hospital_code for r in first.records]
    assert codes == sorted(codes)


def _field_names(cls: type) -> set[str]:
    return {field.name for field in dataclasses.fields(cls)}


def test_the_overlay_is_never_ranked_against_the_national_figures() -> None:
    classes = [
        queensland.FacilityMap,
        queensland.FacilityMatch,
        queensland.UnmappedFacility,
        queensland.Specialty,
        queensland.Quarter,
        queensland.CategoryFigures,
        queensland.SpecialtyFigures,
        queensland.FacilityQuarter,
        queensland.Overlay,
    ]
    fields = {name for c in classes for name in _field_names(c)}
    assert not {f for f in fields if "rank" in f or "national" in f or "trend" in f}
    assert not _banned_imports(Path(queensland.__file__).read_text(encoding="utf-8"))


def _banned_imports(source: str) -> list[str]:
    banned = {"surgerywaits.derive", "surgerywaits.nearby"}
    found: list[str] = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            targets = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            base = _resolve(node)
            targets = [base, *(f"{base}.{alias.name}" for alias in node.names)]
        else:
            continue
        found += [t for t in targets if t in banned]
    return found


def _resolve(node: ast.ImportFrom) -> str:
    if not node.level:
        return node.module or ""
    package = queensland.__name__.rsplit(".", 1)[0].split(".")
    package = package[: len(package) - (node.level - 1)]
    return ".".join([*package, *([node.module] if node.module else [])])


def test_the_import_check_catches_every_way_of_reaching_derive_or_nearby() -> None:
    for line in (
        "from surgerywaits import derive",
        "from surgerywaits import derive as d",
        "from . import nearby",
        "from .derive import rank",
        "import surgerywaits.derive as d",
        "from surgerywaits.nearby import mesh",
    ):
        assert _banned_imports(line), line
    assert not _banned_imports("from surgerywaits import suppression\nimport dataclasses")


def _real() -> tuple[Overlay, Register]:
    *register_files, by_category, by_specialty = pinned(*REGISTER_SLUGS, BY_CATEGORY, BY_SPECIALTY)
    register = load_register(*register_files)
    return load_overlay(by_category, by_specialty, register), register


def test_real_data_maps_every_facility_but_one_and_every_specialty() -> None:
    overlay, _ = _real()
    facilities = overlay.facilities
    by_name = sum(m.matched_by is MatchedBy.NAME for m in facilities.matches)
    assert (len(facilities.matches), by_name) == (48, 44)
    assert {m.facility_code for m in facilities.matches if m.matched_by is MatchedBy.OVERRIDE} == {
        "22",
        "33",
        "120",
        "200",
    }
    assert [(u.facility_code, u.facility_name, u.reason) for u in facilities.unmapped] == [
        ("346", "Noosa", "no public hospital in the national register carries this name")
    ]
    assert [(n.facility_code, n.facility_name) for n in facilities.not_facilities] == [
        ("99999", "Queensland Reporting Hospitals")
    ]
    assert overlay.quarters == (SEP_25,)
    assert (len(overlay.specialties), len(overlay.records)) == (11, 48)
    assert (
        sum(len(r.categories) for r in overlay.records),
        sum(len(r.specialties) for r in overlay.records),
    ) == (144, 240)
    assert {r.release_date for r in overlay.records} == {date(2025, 10, 28)}
    states = [f.state for r in overlay.records for f in r.total]
    assert (states.count(FigureState.PUBLISHED), states.count(FigureState.NOT_PUBLISHED)) == (
        429,
        3,
    )
    assert overlay == _real()[0]


def test_real_data_needs_each_override() -> None:
    overlay, register = _real()
    names = {m.facility_code: m.facility_name for m in overlay.facilities.matches}
    names |= {u.facility_code: u.facility_name for u in overlay.facilities.unmapped}
    bare = map_facilities(names, register.hospitals, overrides={})
    assert {u.facility_code for u in bare.unmapped} == {"22", "33", "120", "200", "346"}
    assert {u.facility_code: u.reason for u in bare.unmapped}["200"] == (
        "more than one national hospital carries this name: H0489, H0536"
    )
