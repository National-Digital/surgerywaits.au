from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass

from surgerywaits.catalogue import Role
from surgerywaits.derive import ROLE_ORDER, TrendPoint, trend_points
from surgerywaits.hospitals import STATES
from surgerywaits.suppression import Figure, SuppressedTable
from surgerywaits.waiting_times import NATIONAL_SCOPE

SCOPES = (NATIONAL_SCOPE, *STATES)


class BenchmarkError(Exception):
    pass


@dataclass(frozen=True)
class Benchmarks:
    """State and national figures for one table. Nothing here is ranked."""

    # (category, scope) -> the newest period's figures by role.
    current: Mapping[tuple[str, str], tuple[tuple[Role, Figure], ...]]
    # (category, scope, role) -> every period, oldest first.
    series: Mapping[tuple[str, str, Role], tuple[TrendPoint, ...]]


def derive_benchmarks(suppressed: SuppressedTable, newest: str) -> Benchmarks:
    """The newest period's figures and every period's series, for each category and scope."""
    current: dict[tuple[str, str], tuple[tuple[Role, Figure], ...]] = {}
    found: dict[tuple[str, str, Role], list[tuple[str, Figure]]] = defaultdict(list)
    for s in suppressed.benchmarks:
        b = s.benchmark
        if b.scope not in SCOPES:
            msg = f"a benchmark is scoped {b.scope!r}, which is not national or a state"
            raise BenchmarkError(msg)
        roles = {c.column: c.role for c in b.cells}
        rows = sorted(
            ((role, f) for f in s.figures if (role := roles[f.column]) is not None),
            key=lambda rf: ROLE_ORDER.index(rf[0]),
        )
        for role, figure in rows:
            found[b.category, b.scope, role].append((b.period, figure))
        if b.period == newest:
            current[b.category, b.scope] = tuple(rows)
    series = {k: trend_points(v) for k, v in sorted(found.items())}
    return Benchmarks(current, series)
