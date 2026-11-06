import copy
from collections import Counter
from collections.abc import Callable
from typing import Any

import pytest

import realdata
from fixture_dist import fixture_docs, fixture_inputs
from surgerywaits.benchmarks import BenchmarkError, derive_benchmarks
from surgerywaits.catalogue import Role
from surgerywaits.contract import ContractError, validate
from surgerywaits.dist import Doc
from surgerywaits.gates import GateError, check_benchmarks
from surgerywaits.hospitals import Hospital, Register
from surgerywaits.suppression import (
    FigureState,
    Reason,
    SuppressedTable,
    SuppressionError,
    suppress,
)
from surgerywaits.waiting_times import Row, Table, WaitingTimesError, build
from test_dist import PUBLISHED, RELEASE, real_docs

Change = Callable[[Doc], object]
DASH = chr(0x2013)
PERIOD = f"2024{DASH}25"
ROLES = {"median_wait", "volume", "long_wait"}
NOT_PUBLISHED = {
    "state": "not_published",
    "reason": "not_published_by_aihw",
    "period": PERIOD,
    "release": RELEASE,
}
REGISTER = Register(
    (
        Hospital(
            code="H1",
            name="Alpha Hospital",
            alternative_names=(),
            state="NSW",
            latitude=None,
            longitude=None,
            closed=False,
            network_code=None,
            network_name=None,
            network_status="unmapped",
        ),
    ),
    (),
    (),
)
# Counts of benchmark rows and of newest-period figures at the pinned versions.
PINNED_ROWS = {Table.URGENCY: (0, 0), Table.PROCEDURE: (1438, 9699), Table.SPECIALTY: (163, 1251)}
PINNED_CURRENT = {"procedure": (453, 2802), "specialty": (36, 279), "urgency": (0, 0)}
PINNED_REASONS = {"not_published_by_aihw": 968, "too_few_patients": 92}


def _row(level: str = "State", scope: str = "NSW", **changes: object) -> Row:
    row: Row = {
        "reporting_unit": "New South Wales" if level == "State" else "National",
        "reporting_unit_type": level,
        "state": scope,
        "peer_group": "National",
        "year": PERIOD,
        "intended_procedure": "Hip replacement",
        "surgeries": 170,
        "median_wait_days": 22,
        "peer_group_median_days": 21,
        "share_waited_over_365_days": 0.006,
        "peer_group_average": 0.001,
        "suppressed": [],
        "markers": None,
    }
    return {**row, **changes}


def _built(*rows: Row) -> Any:  # noqa: ANN401
    return build(list(rows), Table.PROCEDURE, REGISTER)


def _surgery(kind: str = "procedure") -> Doc:
    return copy.deepcopy(
        next(
            d
            for _, (k, d) in sorted(fixture_docs().items())
            if k == "surgery" and d["kind"] == kind
        )
    )


def _state_file() -> Doc:
    return copy.deepcopy(fixture_docs()["states/nsw.json"][1])


def _figures(measures: Doc | None) -> list[Doc]:
    return list((measures or {}).values())


def test_state_and_national_rows_become_benchmarks_without_peer_columns() -> None:
    result = _built(_row(), _row("National", "NAT"))
    assert [(b.scope, b.category, b.period) for b in result.benchmarks] == [
        ("NAT", "Hip replacement", PERIOD),
        ("NSW", "Hip replacement", PERIOD),
    ]
    assert {c.column for b in result.benchmarks for c in b.cells} == {
        "surgeries",
        "median_wait_days",
        "share_waited_over_365_days",
    }
    assert result.other_levels == (("National", 1), ("State", 1))


def test_a_network_row_is_not_a_benchmark() -> None:
    assert _built(_row("Local Hospital Network")).benchmarks == ()


def test_two_benchmark_rows_for_one_scope_category_and_period_fail() -> None:
    with pytest.raises(WaitingTimesError, match="NSW has two benchmark rows"):
        _built(_row(), _row())


def test_a_state_row_scoped_national_fails() -> None:
    with pytest.raises(WaitingTimesError, match="a State row is scoped 'NAT'"):
        _built(_row(scope="NAT"))


def test_a_suppressed_benchmark_carries_its_reason_and_never_a_value() -> None:
    row = _row(
        median_wait_days=None,
        surgeries=None,
        suppressed=["median_wait_days"],
        markers='{"median_wait_days":"NP","surgeries":"<5"}',
    )
    (suppressed,) = suppress(_built(row)).benchmarks
    by_column = {f.column: f for f in suppressed.figures}
    assert by_column["median_wait_days"].state is FigureState.NOT_PUBLISHED
    assert by_column["median_wait_days"].reason is Reason.NOT_PUBLISHED_BY_AIHW
    assert by_column["surgeries"].reason is Reason.TOO_FEW_PATIENTS
    assert by_column["surgeries"].value is None
    assert by_column["share_waited_over_365_days"].value == 0.006  # noqa: PLR2004


def test_a_benchmark_cell_with_an_unknown_marker_fails() -> None:
    row = _row(median_wait_days=None, markers='{"median_wait_days":"??"}')
    with pytest.raises(SuppressionError, match="unknown marker"):
        suppress(_built(row))


def _table(*rows: Row) -> SuppressedTable:
    return suppress(_built(*rows))


def test_only_the_newest_period_is_current_and_the_history_keeps_every_period() -> None:
    older = _row(year=f"2023{DASH}24", median_wait_days=20)
    found = derive_benchmarks(_table(older, _row()), PERIOD)
    assert [r for r, _ in found.current["Hip replacement", "NSW"]] == [
        Role.MEDIAN_WAIT,
        Role.VOLUME,
        Role.LONG_WAIT,
    ]
    points = found.series["Hip replacement", "NSW", Role.MEDIAN_WAIT]
    assert [(p.period, p.figure.value, p.change) for p in points] == [
        (f"2023{DASH}24", 20, None),
        (PERIOD, 22, 2),
    ]


def test_a_benchmark_in_an_older_period_only_is_not_current() -> None:
    older = _row(year=f"2023{DASH}24")
    assert derive_benchmarks(_table(older), PERIOD).current == {}


def test_a_benchmark_with_an_unknown_scope_fails() -> None:
    with pytest.raises(BenchmarkError, match="'OT'"):
        derive_benchmarks(_table(_row(scope="OT")), PERIOD)


def test_the_fixture_build_carries_benchmarks_on_every_non_urgency_surgery() -> None:
    surgeries = [d for _, (k, d) in fixture_docs().items() if k == "surgery"]
    assert {d["kind"] for d in surgeries} == {"urgency", "procedure", "specialty"}
    for d in surgeries:
        b = d["benchmarks"]
        if d["kind"] == "urgency":
            assert b == {"national": None, "states": [], "trends": []}
            continue
        assert set(b["national"]) == ROLES
        assert {e["state"] for e in b["states"]} <= {"NSW", "Vic", "Qld", "ACT"}
        assert b["trends"]
        assert all(
            s["scope"] == "NAT" or s["scope"] in {"NSW", "Vic", "Qld", "ACT"} for s in b["trends"]
        )


def test_a_fixture_benchmark_can_be_not_published_with_a_reason() -> None:
    figures = [
        f
        for _, (k, d) in fixture_docs().items()
        if k == "surgery"
        for e in d["benchmarks"]["states"]
        for f in _figures(e["measures"])
    ]
    withheld = [f for f in figures if f["state"] != "published"]
    assert withheld
    assert all("value" not in f and f["reason"] for f in withheld)
    assert all(f["period"] and f["release"] for f in figures)


def test_each_state_file_repeats_its_surgery_benchmarks() -> None:
    docs = fixture_docs()
    assert sorted(p for p in docs if p.startswith("states/")) == [
        "states/act.json",
        "states/nsw.json",
        "states/qld.json",
        "states/vic.json",
    ]
    check_benchmarks(docs)
    nsw = docs["states/nsw.json"][1]
    assert nsw["state"] == "NSW"
    assert nsw["name"] == "New South Wales"
    assert nsw["scope"]["sector"] == "public"
    for row in nsw["surgeries"]:
        assert row["national"] is not None


def test_a_state_file_that_drifts_from_its_surgery_file_is_caught() -> None:
    docs = copy.deepcopy(fixture_docs())
    docs["states/nsw.json"][1]["surgeries"][0]["measures"]["volume"] = PUBLISHED
    with pytest.raises(GateError, match="disagree about the benchmarks"):
        check_benchmarks(docs)
    docs = copy.deepcopy(fixture_docs())
    docs["states/vic.json"][1]["surgeries"].pop()
    with pytest.raises(GateError, match="disagree about the benchmarks"):
        check_benchmarks(docs)


BAD_BENCHMARKS: list[tuple[str, Change]] = [
    ("a rank on a figure", lambda b: b["national"]["median_wait"].update(rank=1)),
    (
        "a reason that is not in the list",
        lambda b: b["national"]["median_wait"].update(state="not_published", reason="x"),
    ),
    (
        "a value on a withheld figure",
        lambda b: b["national"].update(median_wait={**NOT_PUBLISHED, "value": 0}),
    ),
    ("no release", lambda b: b["national"]["median_wait"].pop("release")),
    ("no period", lambda b: b["national"]["median_wait"].pop("period")),
    ("a negative value", lambda b: b["national"]["median_wait"].update(value=-1)),
    ("an unknown measure", lambda b: b["national"].update(on_time=PUBLISHED, extra=PUBLISHED)),
    (
        "a ranked measure",
        lambda b: b["national"].update(
            median_wait={"figure": PUBLISHED, "rank": {"status": "ranked"}}
        ),
    ),
    ("Other Territories", lambda b: b["states"][0].update(state="OT")),
    ("national as a state", lambda b: b["states"][0].update(state="NAT")),
    ("a state with no measures", lambda b: b["states"][0].pop("measures")),
    ("a state with empty measures", lambda b: b["states"][0].update(measures={})),
    ("a rank on a state", lambda b: b["states"][0].update(rank=1)),
    ("no trends", lambda b: b.pop("trends")),
    ("a position on the benchmarks", lambda b: b.update(position=1)),
    ("an unknown trend scope", lambda b: b["trends"][0].update(scope="OT")),
    ("a trend with a missing point", lambda b: b["trends"][0]["points"].pop()),
    (
        "a malformed trend point",
        lambda b: b["trends"][0].update(points=[[2023, 5, None, "x"], [2024, 6, 1]]),
    ),
]


@pytest.mark.parametrize(
    "change", [c for _, c in BAD_BENCHMARKS], ids=[name for name, _ in BAD_BENCHMARKS]
)
def test_a_bad_benchmark_is_rejected(change: Change) -> None:
    page = _surgery()
    validate("surgery", page)
    change(page["benchmarks"])
    with pytest.raises(ContractError):
        validate("surgery", page)


def test_a_benchmark_must_state_the_pages_period_and_release() -> None:
    page = _surgery()
    page["benchmarks"]["national"]["volume"]["period"] = f"2023{DASH}24"
    with pytest.raises(ContractError, match="not the page's"):
        validate("surgery", page)
    page = _surgery()
    page["benchmarks"]["states"][0]["measures"]["volume"]["release"] = "2020-01-01"
    with pytest.raises(ContractError, match="not the page's"):
        validate("surgery", page)


def test_a_state_listed_twice_or_out_of_order_is_rejected() -> None:
    page = _surgery()
    page["benchmarks"]["states"].append(copy.deepcopy(page["benchmarks"]["states"][0]))
    with pytest.raises(ContractError, match="twice or out of order"):
        validate("surgery", page)
    page = _surgery()
    page["benchmarks"]["states"].reverse()
    with pytest.raises(ContractError, match="twice or out of order"):
        validate("surgery", page)


def test_a_benchmark_trend_follows_the_trend_rules_and_scope_and_role_are_unique() -> None:
    page = _surgery()
    series = page["benchmarks"]["trends"][0]
    series["points"][0][2] = 1
    with pytest.raises(ContractError, match="first point has a change"):
        validate("surgery", page)
    page = _surgery()
    page["benchmarks"]["trends"].append(copy.deepcopy(page["benchmarks"]["trends"][0]))
    with pytest.raises(ContractError, match="two series"):
        validate("surgery", page)


def test_the_urgency_table_publishes_no_benchmark() -> None:
    page = _surgery("urgency")
    validate("surgery", page)
    page["benchmarks"]["national"] = copy.deepcopy(_surgery()["benchmarks"]["national"])
    with pytest.raises(ContractError, match="urgency table publishes no benchmark"):
        validate("surgery", page)


BAD_STATE_FILES: list[tuple[str, Change]] = [
    ("a rank on the file", lambda d: d.update(rank=1)),
    ("Other Territories", lambda d: d.update(state="OT")),
    ("a rank on a figure", lambda d: d["surgeries"][0]["measures"]["volume"].update(rank=1)),
    ("no national figure key", lambda d: d["surgeries"][0].pop("national")),
    ("an unknown field", lambda d: d["surgeries"][0].update(trend=[])),
    ("no scope", lambda d: d.pop("scope")),
    ("no surgeries", lambda d: d.update(surgeries=[])),
    ("no sources", lambda d: d.update(sources=[])),
]


@pytest.mark.parametrize(
    "change", [c for _, c in BAD_STATE_FILES], ids=[name for name, _ in BAD_STATE_FILES]
)
def test_a_bad_state_file_is_rejected(change: Change) -> None:
    page = _state_file()
    validate("state", page)
    change(page)
    with pytest.raises(ContractError):
        validate("state", page)


def test_a_state_file_must_state_each_rows_period() -> None:
    page = _state_file()
    page["surgeries"][0]["national"]["volume"]["period"] = f"2020{DASH}21"
    with pytest.raises(ContractError, match="not the page's"):
        validate("state", page)


def test_no_fixture_benchmark_holds_a_rank() -> None:
    for path, (kind, d) in fixture_docs().items():
        if kind == "state":
            assert "rank" not in str(d), path
        if kind == "surgery":
            assert "rank" not in str(d["benchmarks"]), path


def test_the_fixture_state_files_cite_the_tables_they_use() -> None:
    sources = set(fixture_docs()["states/nsw.json"][1]["sources"])
    assert "au-elective-surgery-waiting-times-by-procedure" in sources
    assert "au-elective-surgery-waiting-times-by-specialty" in sources
    assert "au-elective-surgery-waiting-times" not in sources
    assert fixture_inputs().tables[Table.URGENCY].benchmarks == ()


def test_the_pinned_releases_carry_every_state_and_national_row_as_a_benchmark() -> None:
    from surgerywaits.build import read_inputs  # noqa: PLC0415
    from surgerywaits.manifest import load  # noqa: PLC0415

    entries = load()
    paths = dict(
        zip((e.slug for e in entries), realdata.pinned(*(e.slug for e in entries)), strict=True)
    )
    tables = read_inputs(entries, paths).tables
    for table, (national, state) in PINNED_ROWS.items():
        found = Counter(b.benchmark.scope == "NAT" for b in tables[table].benchmarks)
        assert (found[True], found[False]) == (national, state), table


def test_the_pinned_dist_carries_the_expected_benchmark_figures() -> None:
    docs = real_docs()
    current: dict[str, list[int]] = {k: [0, 0] for k in PINNED_CURRENT}
    reasons: Counter[str] = Counter()
    for path, d in docs.items():
        if not path.startswith("surgeries/") or path.count("/") != 2:  # noqa: PLR2004
            continue
        b = d["benchmarks"]
        scopes = [(True, b["national"])] + [(False, e["measures"]) for e in b["states"]]
        for national, measures in scopes:
            for figure in _figures(measures):
                current[d["kind"]][0 if national else 1] += 1
                if figure["state"] != "published":
                    reasons[figure["reason"]] += 1
    assert {k: tuple(v) for k, v in current.items()} == PINNED_CURRENT
    assert dict(reasons) == PINNED_REASONS
    assert sorted(p for p in docs if p.startswith("states/")) == [
        f"states/{s}.json" for s in ("act", "nsw", "nt", "qld", "sa", "tas", "vic", "wa")
    ]
