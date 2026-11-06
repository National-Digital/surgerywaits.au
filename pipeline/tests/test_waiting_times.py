import json
import random
from collections import Counter
from pathlib import Path

import pytest

from surgerywaits.catalogue import ALLOWED_ROLES, Role
from surgerywaits.catalogue import load as load_catalogue
from surgerywaits.hospitals import Hospital, Register, load_register
from surgerywaits.waiting_times import (
    SPECS,
    HospitalIndex,
    Match,
    Row,
    Table,
    WaitingTimes,
    WaitingTimesError,
    build,
    load,
    read_rows,
)

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "pipeline" / "tests" / "fixtures"
CACHE = ROOT / "pipeline" / ".downloads"
REGISTER_SLUGS = (
    "au-myhospitals-reporting-units",
    "au-myhospitals-reporting-unit-mappings",
    "au-hospitals-myhospitals",
)
SLUGS = {
    Table.URGENCY: "au-elective-surgery-waiting-times",
    Table.PROCEDURE: "au-elective-surgery-waiting-times-by-procedure",
    Table.SPECIALTY: "au-elective-surgery-waiting-times-by-specialty",
}
CATEGORY_TYPES = {
    Table.URGENCY: "ES_URGENCY",
    Table.PROCEDURE: "ES_IP",
    Table.SPECIALTY: "ES_SS",
}
NORTHEAST = "Northeast Health Wangaratta"
OLD_NAME = "North Canberra Hospital (previously known as Calvary Public Hospital Bruce)"


def _hospital(
    code: str, name: str, state: str = "NSW", alternatives: tuple[str, ...] = ()
) -> Hospital:
    return Hospital(
        code=code,
        name=name,
        alternative_names=alternatives,
        state=state,
        latitude=None,
        longitude=None,
        closed=False,
        network_code=None,
        network_name=None,
        network_status="unmapped",
    )


def _register(*hospitals: Hospital) -> Register:
    return Register(hospitals, (), ())


def _row(name: str = "Alpha Hospital", state: str = "NSW", **changes: object) -> Row:
    row: Row = {
        "reporting_unit": name,
        "reporting_unit_type": "Hospital",
        "state": state,
        "peer_group": "Small hospitals",
        "year": "2023\u201324",
        "urgency_category": "Urgent elective surgery",
        "surgeries": 120,
        "median_wait_days": 14,
        "peer_group_median_days": 15,
        "share_within_recommended_time": 0.97,
        "peer_group_average": 0.95,
        "suppressed": [],
        "markers": None,
    }
    return {**row, **changes}


ALPHA = _register(_hospital("H1", "Alpha Hospital", alternatives=("Alpha",)))


def _fixture(slug: str) -> Path:
    return FIXTURES / slug / "data.parquet"


def _fixture_register() -> Register:
    return load_register(*(_fixture(s) for s in REGISTER_SLUGS))


def _fixture_tables() -> dict[Table, WaitingTimes]:
    register = _fixture_register()
    return {t: load(_fixture(s), t, register) for t, s in SLUGS.items()}


def _fail(rows: list[Row], register: Register = ALPHA) -> str:
    with pytest.raises(WaitingTimesError) as err:
        build(rows, Table.URGENCY, register)
    return str(err.value)


def test_a_name_joins_to_its_code() -> None:
    (one,) = build([_row()], Table.URGENCY, ALPHA).observations
    assert (one.code, one.matched_by, one.published_name) == ("H1", "name", "Alpha Hospital")
    assert (one.period, one.category, one.peer_group) == (
        "2023\u201324",
        "Urgent elective surgery",
        "Small hospitals",
    )


def test_an_alternative_name_joins_when_no_register_name_fits() -> None:
    (one,) = build([_row("Alpha")], Table.URGENCY, ALPHA).observations
    assert (one.code, one.matched_by) == ("H1", "alternative_name")


def test_case_and_spacing_do_not_change_the_join() -> None:
    (one,) = build([_row("  ALPHA   hospital ")], Table.URGENCY, ALPHA).observations
    assert one.code == "H1"


def test_a_register_name_outranks_another_hospitals_alias() -> None:
    register = _register(
        _hospital("H1", "Alpha Hospital"), _hospital("H2", "Beta", alternatives=("Alpha Hospital",))
    )
    assert HospitalIndex(register).match("Alpha Hospital", "NSW") == Match("H1", "name")


def test_an_alias_shared_by_two_hospitals_is_ambiguous() -> None:
    register = _register(
        _hospital("H1", "Alpha Hospital", alternatives=("Shared",)),
        _hospital("H2", "Beta Hospital", alternatives=("Shared",)),
    )
    message = _fail([_row("Shared")], register)
    assert "ambiguous" in message
    assert "H1, H2" in message


def test_two_hospitals_with_one_name_are_ambiguous() -> None:
    register = _register(_hospital("H1", "Alpha Hospital"), _hospital("H2", "alpha hospital"))
    assert "ambiguous" in _fail([_row()], register)


def test_a_renamed_hospital_fails_closed() -> None:
    message = _fail([_row("Alpha Hospital (renamed)")])
    assert "'Alpha Hospital (renamed)' (NSW): unmatched" in message


def test_the_same_name_in_another_state_does_not_join() -> None:
    assert "unmatched" in _fail([_row(state="Vic")])


def test_every_failing_name_is_reported_once_in_order() -> None:
    message = _fail([_row("Zed"), _row("Zed", year="2022\u201323"), _row("Yak")])
    assert message.startswith("urgency: 2 hospital names do not join: 'Yak'")
    assert message.count("'Zed'") == 1


def test_rows_above_hospital_level_are_counted_and_left_out() -> None:
    rows = [
        _row(),
        _row("Alpha Hospital", reporting_unit_type="Local Hospital Network"),
        _row("Nowhere", reporting_unit_type="State"),
    ]
    result = build(rows, Table.URGENCY, ALPHA)
    assert [o.code for o in result.observations] == ["H1"]
    assert result.other_levels == (("Local Hospital Network", 1), ("State", 1))


def test_an_unknown_reporting_unit_type_fails() -> None:
    assert "unknown reporting unit type 'Ward'" in _fail([_row(reporting_unit_type="Ward")])


def test_two_rows_for_one_hospital_category_and_period_fail() -> None:
    assert "two rows" in _fail([_row(), _row("Alpha")])


def test_a_changed_column_set_fails() -> None:
    extra = {**_row(), "new_measure": 1}
    assert "unexpected ['new_measure']" in _fail([extra])
    lacking = {k: v for k, v in _row().items() if k != "median_wait_days"}
    assert "missing ['median_wait_days']" in _fail([lacking])


def test_an_empty_table_fails() -> None:
    assert "no rows" in _fail([])


@pytest.mark.parametrize(
    ("changes", "expected"),
    [
        ({"year": "2023-24"}, "not a reference period"),
        ({"reporting_unit": " "}, "reporting_unit is missing"),
        ({"surgeries": True}, "surgeries is not a number"),
        ({"surgeries": 12.5}, "surgeries is not a whole number"),
        ({"surgeries": "12"}, "surgeries is not a number"),
        ({"peer_group": 5}, "peer_group is not text"),
        ({"markers": "{"}, "markers are not JSON"),
        ({"markers": "[]"}, "markers are not an object"),
        ({"markers": '{"colour":"NP"}'}, "'colour', which is not a value column"),
        ({"markers": '{"surgeries":""}'}, "marker for 'surgeries' is not a code"),
        ({"markers": '{"surgeries":5}'}, "marker for 'surgeries' is not a code"),
    ],
)
def test_a_malformed_cell_fails(changes: dict[str, object], expected: str) -> None:
    assert expected in _fail([{**_row(), **changes}])


def test_raw_values_and_every_marker_are_kept_beside_each_other() -> None:
    markers = {"surgeries": "<5", "median_wait_days": "NP", "peer_group_median_days": "Not peered"}
    row = _row(
        surgeries=None,
        median_wait_days=None,
        peer_group_median_days=None,
        share_within_recommended_time=0.0,
        markers=json.dumps(markers),
    )
    (one,) = build([row], Table.URGENCY, ALPHA).observations
    cells = {c.column: c for c in one.cells}
    assert (cells["surgeries"].value, cells["surgeries"].marker) == (None, "<5")
    assert (cells["median_wait_days"].value, cells["median_wait_days"].marker) == (None, "NP")
    assert cells["peer_group_median_days"].marker == "Not peered"
    # A zero stays a zero with no marker; nothing here reads a value as suppressed.
    assert (
        cells["share_within_recommended_time"].value,
        cells["share_within_recommended_time"].marker,
    ) == (
        0.0,
        None,
    )
    assert cells["peer_group_average"].marker is None


def test_a_marker_is_kept_even_beside_a_value() -> None:
    row = _row(markers='{"surgeries":"NP"}')
    (one,) = build([row], Table.URGENCY, ALPHA).observations
    assert (one.cells[0].value, one.cells[0].marker) == (120, "NP")


def test_the_order_of_the_input_does_not_change_the_output() -> None:
    rows = [
        _row(year=y, urgency_category=c)
        for y in ("2021\u201322", "2023\u201324", "2022\u201323")
        for c in ("Urgent elective surgery", "Non-urgent elective surgery")
    ]
    expected = build(rows, Table.URGENCY, ALPHA)
    shuffled = random.Random(7).sample(rows, len(rows))  # noqa: S311 - a fixed seed, not security
    assert build(shuffled, Table.URGENCY, ALPHA) == expected
    keys = [(o.code, o.category, o.period) for o in expected.observations]
    assert keys == sorted(keys)


@pytest.mark.parametrize("table", list(Table))
def test_each_tables_roles_are_those_the_catalogue_allows(table: Table) -> None:
    roles = {c.role for c in SPECS[table].columns if c.role is not None}
    assert roles == ALLOWED_ROLES[CATEGORY_TYPES[table]]
    assert Role.MEDIAN_WAIT in roles


@pytest.mark.parametrize("table", list(Table))
def test_the_fixture_tables_join_and_stay_sorted(table: Table) -> None:
    result = _fixture_tables()[table]
    codes = {h.code for h in _fixture_register().hospitals}
    assert result.observations
    assert {o.code for o in result.observations} <= codes
    keys = [(o.code, o.category, o.period) for o in result.observations]
    assert keys == sorted(keys)
    assert len(set(keys)) == len(keys)


def test_the_fixtures_carry_more_than_one_period_per_hospital() -> None:
    for result in _fixture_tables().values():
        periods: dict[str, set[str]] = {}
        for o in result.observations:
            periods.setdefault(o.code, set()).add(o.period)
        assert max(len(p) for p in periods.values()) >= 2  # noqa: PLR2004


def test_the_fixtures_carry_every_publisher_marker() -> None:
    found = {
        c.marker
        for result in _fixture_tables().values()
        for o in result.observations
        for c in o.cells
        if c.marker
    }
    assert found == {"<5", "-", "NP", "Not peered"}


def test_a_network_that_shares_a_hospitals_name_is_not_joined_as_a_hospital() -> None:
    register = _fixture_register()
    result = _fixture_tables()[Table.URGENCY]
    code = next(h.code for h in register.hospitals if h.name == NORTHEAST)
    assert dict(result.other_levels)["Local Hospital Network"] > 0
    assert {o.published_name for o in result.observations if o.code == code} == {NORTHEAST}


def test_a_hospital_published_under_old_and_new_names_joins_to_two_codes() -> None:
    register = _fixture_register()
    codes = {h.name: h.code for h in register.hospitals}
    old, new = codes[OLD_NAME], codes["North Canberra Hospital"]
    assert old != new
    for result in _fixture_tables().values():
        names = {o.code: o.published_name for o in result.observations if o.code in {old, new}}
        assert names == {old: OLD_NAME, new: "North Canberra Hospital"}


def test_a_hospital_with_a_shared_alias_joins_by_its_own_name() -> None:
    register = _fixture_register()
    shared = next(a for a in register.shared_aliases if a.alias == "Wollongong")
    assert len(shared.codes) >= 2  # noqa: PLR2004
    ambiguous = HospitalIndex(register).match("Wollongong", "NSW")
    assert isinstance(ambiguous, str)
    assert ambiguous.startswith("ambiguous")
    matched = {
        o.matched_by
        for r in _fixture_tables().values()
        for o in r.observations
        if o.code in shared.codes
    }
    assert matched == {"name"}


def test_a_renamed_fixture_hospital_fails_the_join() -> None:
    register = _fixture_register()
    rows = read_rows(_fixture(SLUGS[Table.URGENCY]))
    renamed = [
        {**r, "reporting_unit": "Armidale Health Service"}
        if r["reporting_unit"] == "Armidale Hospital"
        else r
        for r in rows
    ]
    with pytest.raises(WaitingTimesError, match=r"'Armidale Health Service' \(NSW\): unmatched"):
        build(renamed, Table.URGENCY, register)


def _real(slug: str) -> Path:
    manifest = json.loads((ROOT / "data" / "manifest.json").read_text("utf-8"))
    return CACHE / next(d["sha256"] for d in manifest["datasets"] if d["slug"] == slug)


def test_the_pinned_releases_join_in_full() -> None:
    needed = [*REGISTER_SLUGS, *SLUGS.values(), "au-myhospitals-reported-measures"]
    if not all(_real(s).is_file() for s in needed):
        pytest.skip("the pinned files are not cached")
    register = load_register(*(_real(s) for s in REGISTER_SLUGS))
    catalogue = load_catalogue(_real("au-myhospitals-reported-measures"))
    results = {t: load(_real(s), t, register) for t, s in SLUGS.items()}
    expected = {
        Table.URGENCY: (10620, 3, (("Local Hospital Network", 1539),)),
        Table.PROCEDURE: (
            126911,
            151,
            (("Local Hospital Network", 45881), ("National", 1438), ("State", 9699)),
        ),
        Table.SPECIALTY: (
            21826,
            12,
            (("Local Hospital Network", 4662), ("National", 163), ("State", 1251)),
        ),
    }
    names = {c.name for c in catalogue.categories}
    for table, result in results.items():
        count, categories, others = expected[table]
        assert len(result.observations) == count
        assert result.other_levels == others
        assert {o.category for o in result.observations} == {
            c.name for c in catalogue.categories if c.type_code == CATEGORY_TYPES[table]
        }
        assert len({o.category for o in result.observations}) == categories
        assert {o.category for o in result.observations} <= names
        assert len({o.code for o in result.observations}) == 293  # noqa: PLR2004
        assert len({o.period for o in result.observations}) == 14  # noqa: PLR2004
        assert Counter(o.matched_by for o in result.observations) == {"name": count}
        assert {c.marker for o in result.observations for c in o.cells if c.marker} == {
            "<5",
            "-",
            "NP",
            "Not peered",
        }
