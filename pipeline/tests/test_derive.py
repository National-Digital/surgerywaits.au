from collections import Counter
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path

import pytest

from surgerywaits.catalogue import Role
from surgerywaits.derive import (
    Derived,
    DerivedObservation,
    RankStatus,
    derive,
    derive_table,
    derive_trends,
)
from surgerywaits.hospitals import Hospital, Register, load_register
from surgerywaits.manifest import load
from surgerywaits.nearby import NEIGHBOURS, build_meshes, distance_km
from surgerywaits.pull import CACHE_DIR
from surgerywaits.suppression import SuppressedTable, suppress
from surgerywaits.waiting_times import Cell, Observation, Table, WaitingTimes
from surgerywaits.waiting_times import load as load_waiting_times


def _period(year: int) -> str:
    return f"{year}\u2013{(year + 1) % 100:02d}"


P20, P21, P22, P23, P24 = (_period(y) for y in (2020, 2021, 2022, 2023, 2024))
CATEGORY = "Urgent elective surgery"


def _obs(
    code: str,
    period: str,
    median: int | None,
    on_time: float | None = 50.0,
    category: str = CATEGORY,
) -> Observation:
    cells = (
        Cell("surgeries", Role.VOLUME, 100, None),
        Cell("median_wait_days", Role.MEDIAN_WAIT, median, None if median is not None else "NP"),
        Cell(
            "share_within_recommended_time",
            Role.ON_TIME,
            on_time,
            None if on_time is not None else "<5",
        ),
    )
    return Observation(code, code, "name", period, category, None, cells)


def _table(*observations: Observation) -> SuppressedTable:
    return suppress(WaitingTimes(Table.URGENCY, observations, ()))


def _hospital(code: str, lat: float | None, lon: float | None, *, closed: bool = False) -> Hospital:
    return Hospital(code, code, (), "NSW", lat, lon, closed, None, None, "mapped")


def _by_code(
    result: Sequence[DerivedObservation], role: Role, period: str
) -> dict[str, tuple[RankStatus, int | None]]:
    return {
        o.code: (f.status, f.rank)
        for o in result
        for f in o.figures
        if f.role is role and o.period == period
    }


def test_equal_medians_share_a_competition_rank() -> None:
    table = _table(*(_obs(c, P24, m) for c, m in [("A", 5), ("B", 9), ("C", 9), ("D", 12)]))
    result, _ = derive_table(Table.URGENCY, table, frozenset())
    ranks = _by_code(result, Role.MEDIAN_WAIT, P24)
    assert [ranks[c][1] for c in "ABCD"] == [1, 2, 2, 4]


def test_each_role_ranks_in_its_own_direction() -> None:
    table = _table(_obs("A", P24, 5, 40.0), _obs("B", P24, 9, 90.0), _obs("C", P24, 7, 90.0))
    result, _ = derive_table(Table.URGENCY, table, frozenset())
    assert _by_code(result, Role.MEDIAN_WAIT, P24)["A"] == (RankStatus.RANKED, 1)
    on_time = _by_code(result, Role.ON_TIME, P24)
    assert [on_time[c][1] for c in "BCA"] == [1, 1, 3]
    volume = _by_code(result, Role.VOLUME, P24)
    assert set(volume.values()) == {(RankStatus.NOT_A_RANKED_MEASURE, None)}


def test_suppressed_closed_and_stale_rows_get_no_rank() -> None:
    table = _table(
        _obs("A", P23, 1),
        _obs("A", P24, 5),
        _obs("B", P24, None),
        _obs("C", P24, 6),
        _obs("D", P23, 2),
    )
    result, newest = derive_table(Table.URGENCY, table, frozenset({"C"}))
    assert newest == P24
    current = _by_code(result, Role.MEDIAN_WAIT, P24)
    assert current == {
        "A": (RankStatus.RANKED, 1),
        "B": (RankStatus.NOT_PUBLISHED, None),
        "C": (RankStatus.CLOSED, None),
    }
    earlier = _by_code(result, Role.MEDIAN_WAIT, P23)
    assert earlier == {"A": (RankStatus.EARLIER_PERIOD, None), "D": (RankStatus.STALE, None)}


def test_stale_means_latest_period_older_than_the_newest_in_the_table() -> None:
    table = _table(_obs("A", P24, 5), _obs("D", P23, 2), _obs("D", P22, 1))
    result, _ = derive_table(Table.URGENCY, table, frozenset())
    assert {o.code for o in result if o.figures[0].status is RankStatus.STALE} == {"D"}
    other = _table(_obs("A", P24, 5), _obs("A", P24, 3, category="Other"))
    assert len(derive_table(Table.URGENCY, other, frozenset())[0]) == 2  # noqa: PLR2004


def test_trend_change_needs_two_consecutive_published_periods() -> None:
    table = _table(
        _obs("A", P20, 10),
        _obs("A", P21, 14),
        _obs("A", P23, 20),
        _obs("A", P24, None),
    )
    trend = next(t for t in derive_trends(Table.URGENCY, table) if t.role is Role.MEDIAN_WAIT)
    assert [p.period for p in trend.points] == [P20, P21, P23, P24]
    assert [p.change for p in trend.points] == [None, 4, None, None]


def test_distance_matches_a_known_separation() -> None:
    sydney, melbourne = (-33.8688, 151.2093), (-37.8136, 144.9631)
    assert distance_km(sydney, melbourne) == pytest.approx(713.4, abs=1.0)
    assert distance_km(sydney, sydney) == 0


def _line(n: int) -> list[Hospital]:
    return [_hospital(f"H{i:02d}", -30.0 - i * 0.25, 150.0) for i in range(n)]


def test_mesh_has_eight_nearest_and_widens_by_doubling() -> None:
    near = _line(12)
    far = [_hospital(f"F{i}", -20.0 - i * 0.1, 135.0) for i in range(9)]
    meshes = {m.code: m for m in build_meshes([*near, *far]).meshes}
    assert meshes["H00"].radius_km == 250  # noqa: PLR2004
    assert [n.code for n in meshes["H00"].neighbours] == [f"H{i:02d}" for i in range(1, 9)]
    lonely = build_meshes([_hospital("X", -30.0, 150.0), *far[:7], _hospital("Y", -20.0, 135.0)])
    x = next(m for m in lonely.meshes if m.code == "X")
    assert x.radius_km == 2000  # noqa: PLR2004
    assert len(x.neighbours) == NEIGHBOURS


def test_mesh_skips_closed_hospitals_and_reports_missing_coordinates() -> None:
    hospitals = [
        *_line(10),
        _hospital("CL", -30.1, 150.0, closed=True),
        _hospital("NC", None, None),
    ]
    result = build_meshes(hospitals)
    assert result.without_coordinates == ("NC",)
    assert "NC" not in {m.code for m in result.meshes}
    assert all("CL" not in {n.code for n in m.neighbours} for m in result.meshes)
    assert "CL" in {m.code for m in result.meshes}


def test_mesh_crosses_state_borders_and_breaks_ties_by_code() -> None:
    a = _hospital("A", -28.0, 150.0)
    b, c = (replace(_hospital(x, -28.5, 150.0), state="QLD") for x in ("C", "B"))
    result = build_meshes([a, b, c])
    mesh = next(m for m in result.meshes if m.code == "A")
    assert [n.code for n in mesh.neighbours] == ["B", "C"]


REAL_SLUGS = {
    Table.URGENCY: "au-elective-surgery-waiting-times",
    Table.PROCEDURE: "au-elective-surgery-waiting-times-by-procedure",
    Table.SPECIALTY: "au-elective-surgery-waiting-times-by-specialty",
}
HOSPITAL_SLUGS = (
    "au-myhospitals-reporting-units",
    "au-myhospitals-reporting-unit-mappings",
    "au-hospitals-myhospitals",
)


def _real() -> tuple[Register, Derived]:
    files = {e.slug: CACHE_DIR / e.sha256 for e in load()}
    wanted = [*HOSPITAL_SLUGS, *REAL_SLUGS.values()]
    if not all(files[s].is_file() for s in wanted):
        pytest.skip("the pinned files are not in the pipeline cache")
    register = load_register(*(files[s] for s in HOSPITAL_SLUGS))
    tables = {
        t: suppress(load_waiting_times(Path(files[s]), t, register)) for t, s in REAL_SLUGS.items()
    }
    return register, derive(tables, register)


def test_real_data_ranks_and_mesh_hold_their_rules() -> None:
    register, derived = _real()
    assert derived == _real()[1]
    closed = {h.code for h in register.hospitals if h.closed}
    newest = dict(derived.newest_periods)
    for o in derived.observations:
        for f in o.figures:
            if f.rank is not None:
                assert f.figure.rankable
                assert o.period == newest[o.table]
                assert o.code not in closed
            else:
                assert f.status is not RankStatus.RANKED
    expected = {h.code for h in register.hospitals if h.latitude is not None}
    assert {m.code for m in derived.mesh.meshes} == expected
    assert all(len(m.neighbours) == NEIGHBOURS for m in derived.mesh.meshes)
    assert all(n.code not in closed for m in derived.mesh.meshes for n in m.neighbours)
    assert len(derived.mesh.without_coordinates) + len(expected) == len(register.hospitals)
    assert (len(derived.observations), len(derived.trends)) == (159_357, 68_250)
    assert len(expected) == 691  # noqa: PLR2004
    assert Counter(len(m.neighbours) for m in derived.mesh.meshes) == {NEIGHBOURS: len(expected)}
    assert Counter(m.radius_km for m in derived.mesh.meshes) == {250: 628, 500: 38, 1000: 25}
    unlocated = set(derived.mesh.without_coordinates)
    assert (len(unlocated), len(unlocated & closed)) == (23, 22)
    waits = Counter(
        (o.table, f.status)
        for o in derived.observations
        if o.period == newest[o.table]
        for f in o.figures
        if f.role is Role.MEDIAN_WAIT
    )
    for table, ranked, hidden in (
        (Table.PROCEDURE, 6_264, 6_662),
        (Table.SPECIALTY, 1_442, 173),
        (Table.URGENCY, 725, 52),
    ):
        assert waits[table, RankStatus.RANKED] == ranked
        assert waits[table, RankStatus.NOT_PUBLISHED] == hidden


def test_mesh_ends_with_no_open_neighbour_and_keeps_closed_origins() -> None:
    alone = build_meshes([_hospital("A", -30.0, 150.0)])
    assert [(m.code, m.neighbours) for m in alone.meshes] == [("A", ())]
    shut = build_meshes([_hospital("A", -30.0, 150.0), _hospital("B", -30.1, 150.0, closed=True)])
    by = {m.code: [n.code for n in m.neighbours] for m in shut.meshes}
    assert by == {"A": [], "B": ["A"]}
    assert {m.code for m in shut.meshes} == {"A", "B"}
    mixed = build_meshes(
        [_hospital("A", -30.0, 150.0), _hospital("B", -30.1, 150.0, closed=True)]
        + [_hospital(f"O{i}", -31.0 - i * 0.1, 150.0) for i in range(8)]
    )
    closed = next(m for m in mixed.meshes if m.code == "B")
    assert len(closed.neighbours) == NEIGHBOURS
    assert "B" not in {n.code for m in mixed.meshes for n in m.neighbours}
