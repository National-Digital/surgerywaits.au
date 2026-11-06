import itertools
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum

from surgerywaits.catalogue import Role
from surgerywaits.hospitals import Register
from surgerywaits.nearby import MeshSet, build_meshes
from surgerywaits.suppression import Figure, FigureState, SuppressedObservation, SuppressedTable
from surgerywaits.waiting_times import Table

Number = int | float


class DeriveError(Exception):
    pass


class RankStatus(StrEnum):
    RANKED = "ranked"
    NOT_A_RANKED_MEASURE = "not a ranked measure"
    NOT_PUBLISHED = "not published"
    NOT_REPORTED = "not reported"
    CLOSED = "closed"
    STALE = "stale"
    EARLIER_PERIOD = "earlier period"


# Lower is better for a wait; more on time is better; a volume is a count, never ranked.
LOWER_IS_BETTER: Mapping[Role, bool | None] = {
    Role.MEDIAN_WAIT: True,
    Role.LONG_WAIT: True,
    Role.ON_TIME: False,
    Role.VOLUME: None,
}
ROLE_ORDER = tuple(Role)


@dataclass(frozen=True)
class DerivedFigure:
    role: Role
    figure: Figure
    status: RankStatus
    # Competition rank (1, 2, 2, 4), present only when the status is ranked.
    rank: int | None
    # How many hospitals share the ranking, present only when ranked.
    of: int | None


@dataclass(frozen=True)
class DerivedObservation:
    table: Table
    code: str
    category: str
    period: str
    figures: tuple[DerivedFigure, ...]


@dataclass(frozen=True)
class TrendPoint:
    period: str
    figure: Figure
    # Later value minus earlier, only when both consecutive periods are published.
    change: Number | None


@dataclass(frozen=True)
class Trend:
    table: Table
    code: str
    category: str
    role: Role
    points: tuple[TrendPoint, ...]


@dataclass(frozen=True)
class Derived:
    observations: tuple[DerivedObservation, ...]
    trends: tuple[Trend, ...]
    mesh: MeshSet
    # The newest reference period in each table; a hospital with nothing in it is stale.
    newest_periods: tuple[tuple[Table, str], ...]

    def status_counts(self) -> tuple[tuple[tuple[str, str, str], int], ...]:
        """Ranked-versus-unranked tallies per table, role and status, over the newest period."""
        newest = dict(self.newest_periods)
        tally: Counter[tuple[str, str, str]] = Counter()
        for o in self.observations:
            if o.period != newest[o.table]:
                continue
            for f in o.figures:
                tally[o.table.value, f.role.value, f.status.value] += 1
        return tuple(sorted(tally.items()))


def _start_year(period: str) -> int:
    return int(period[:4])


def _roled(o: SuppressedObservation) -> list[tuple[Role, Figure]]:
    roles = {c.column: c.role for c in o.observation.cells}
    found = [(r, f) for f in o.figures if (r := roles[f.column]) is not None]
    return sorted(found, key=lambda rf: ROLE_ORDER.index(rf[0]))


def _status(role: Role, figure: Figure, *, closed: bool, stale: bool, current: bool) -> RankStatus:
    blockers = (
        (LOWER_IS_BETTER[role] is None, RankStatus.NOT_A_RANKED_MEASURE),
        (closed, RankStatus.CLOSED),
        (stale, RankStatus.STALE),
        (not current, RankStatus.EARLIER_PERIOD),
        (figure.state is FigureState.NOT_PUBLISHED, RankStatus.NOT_PUBLISHED),
        (figure.state is FigureState.NOT_REPORTED, RankStatus.NOT_REPORTED),
    )
    return next((status for blocked, status in blockers if blocked), RankStatus.RANKED)


def _competition_ranks(values: Mapping[str, Number], *, lower_is_better: bool) -> dict[str, int]:
    ordered = sorted(values.items(), key=lambda kv: (kv[1] if lower_is_better else -kv[1], kv[0]))
    ranks: dict[str, int] = {}
    for position, (code, value) in enumerate(ordered, start=1):
        previous = ordered[position - 2] if position > 1 else None
        same = previous is not None and previous[1] == value
        ranks[code] = ranks[previous[0]] if previous is not None and same else position
    return ranks


def derive_table(
    table: Table, suppressed: SuppressedTable, closed: frozenset[str]
) -> tuple[tuple[DerivedObservation, ...], str]:
    """Figures with rank status for one table, and the table's newest reference period."""
    if not suppressed.observations:
        msg = f"{table.value}: no observations to derive"
        raise DeriveError(msg)
    newest = max(o.observation.period for o in suppressed.observations)
    latest: dict[tuple[str, str], str] = {}
    for o in suppressed.observations:
        key = (o.observation.code, o.observation.category)
        latest[key] = max(latest.get(key, ""), o.observation.period)

    staged: list[tuple[SuppressedObservation, list[tuple[Role, Figure, RankStatus]]]] = []
    values: dict[tuple[str, Role], dict[str, Number]] = {}
    for o in suppressed.observations:
        ob = o.observation
        stale = latest[ob.code, ob.category] < newest
        row: list[tuple[Role, Figure, RankStatus]] = []
        for role, figure in _roled(o):
            status = _status(
                role, figure, closed=ob.code in closed, stale=stale, current=ob.period == newest
            )
            if status is RankStatus.RANKED and figure.value is not None:
                values.setdefault((ob.category, role), {})[ob.code] = figure.value
            row.append((role, figure, status))
        staged.append((o, row))

    ranks = {
        key: _competition_ranks(v, lower_is_better=bool(LOWER_IS_BETTER[key[1]]))
        for key, v in values.items()
    }
    out: list[DerivedObservation] = []
    for o, row in staged:
        ob = o.observation
        figures = tuple(
            DerivedFigure(
                role,
                figure,
                status,
                ranks[ob.category, role][ob.code] if status is RankStatus.RANKED else None,
                len(ranks[ob.category, role]) if status is RankStatus.RANKED else None,
            )
            for role, figure, status in row
        )
        out.append(DerivedObservation(table, ob.code, ob.category, ob.period, figures))
    out.sort(key=lambda d: (d.table.value, d.category, d.period, d.code))
    return tuple(out), newest


def trend_points(found: list[tuple[str, Figure]]) -> tuple[TrendPoint, ...]:
    """One point for each (period, figure), oldest first, with a change across consecutive years."""
    points: list[TrendPoint] = []
    ordered = sorted(found, key=lambda pf: pf[0])
    for earlier, later in itertools.pairwise([None, *ordered]):
        assert later is not None  # noqa: S101
        change: Number | None = None
        if (
            earlier is not None
            and _start_year(later[0]) == _start_year(earlier[0]) + 1
            and earlier[1].value is not None
            and later[1].value is not None
        ):
            change = later[1].value - earlier[1].value
        points.append(TrendPoint(later[0], later[1], change))
    return tuple(points)


def derive_trends(table: Table, suppressed: SuppressedTable) -> tuple[Trend, ...]:
    series: dict[tuple[str, str, Role], list[tuple[str, Figure]]] = {}
    for o in suppressed.observations:
        ob = o.observation
        for role, figure in _roled(o):
            series.setdefault((ob.code, ob.category, role), []).append((ob.period, figure))
    trends: list[Trend] = []
    for (code, category, role), found in sorted(
        series.items(), key=lambda kv: (kv[0][1], kv[0][0], ROLE_ORDER.index(kv[0][2]))
    ):
        trends.append(Trend(table, code, category, role, trend_points(found)))
    return tuple(trends)


def derive(tables: Mapping[Table, SuppressedTable], register: Register) -> Derived:
    """Ranks, trends and the nearby mesh, built only from the suppression output."""
    closed = frozenset(h.code for h in register.hospitals if h.closed)
    observations: list[DerivedObservation] = []
    trends: list[Trend] = []
    newest: list[tuple[Table, str]] = []
    for table in sorted(tables, key=lambda t: t.value):
        derived, latest = derive_table(table, tables[table], closed)
        observations.extend(derived)
        trends.extend(derive_trends(table, tables[table]))
        newest.append((table, latest))
    return Derived(
        tuple(observations), tuple(trends), build_meshes(register.hospitals), tuple(newest)
    )
