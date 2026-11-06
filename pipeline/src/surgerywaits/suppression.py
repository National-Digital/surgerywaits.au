import math
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import cast

from surgerywaits.waiting_times import Cell, Observation, WaitingTimes


class SuppressionError(Exception):
    pass


class FigureState(StrEnum):
    PUBLISHED = "published"
    NOT_PUBLISHED = "not published"
    NOT_REPORTED = "not reported"


class Reason(StrEnum):
    TOO_FEW_PATIENTS = "too_few_patients"
    NO_PATIENTS_REPORTED = "no_patients_reported"
    NOT_PUBLISHED_BY_AIHW = "not_published_by_aihw"
    NO_PEER_GROUP_COMPARISON = "no_peer_group_comparison"
    NOT_GIVEN_BY_QUEENSLAND_HEALTH = "not_given_by_queensland_health"
    NOT_REPORTED_BY_SOURCE = "not_reported_by_source"


# ADR 0001 D3. "Not peered" is AIHW's own code and the ADR gives it no meaning of its own.
MARKER_REASONS: Mapping[str, Reason] = {
    "<5": Reason.TOO_FEW_PATIENTS,
    "-": Reason.NO_PATIENTS_REPORTED,
    "NP": Reason.NOT_PUBLISHED_BY_AIHW,
    "Not peered": Reason.NO_PEER_GROUP_COMPARISON,
}
PEER_GROUP_REASONS = frozenset({Reason.NO_PEER_GROUP_COMPARISON})

REASON_TEXT: Mapping[Reason, str] = {
    Reason.TOO_FEW_PATIENTS: "too few patients",
    Reason.NO_PATIENTS_REPORTED: "no patients reported",
    Reason.NOT_PUBLISHED_BY_AIHW: "not published by AIHW",
    Reason.NO_PEER_GROUP_COMPARISON: "no peer group comparison",
    Reason.NOT_GIVEN_BY_QUEENSLAND_HEALTH: "Queensland Health gave no figure",
    Reason.NOT_REPORTED_BY_SOURCE: "the source does not report this figure",
}

QLD_VALUE_COLUMNS = (
    "treated",
    "percent_treated_in_time",
    "percent_change_treated_on_prior_year",
    "waiting",
    "long_waits",
    "percent_waiting_in_time",
    "long_waits_ready_for_surgery",
    "long_waits_not_ready_for_surgery",
    "percent_waiting_in_time_ready_for_surgery",
)
# The register says a literal NULL in this column is null without a suppressed flag.
QLD_NULL_COLUMNS = frozenset({"percent_change_treated_on_prior_year"})

Number = int | float

ALLOWED_REASONS: Mapping[FigureState, frozenset[Reason | None]] = {
    FigureState.PUBLISHED: frozenset({None}),
    FigureState.NOT_PUBLISHED: frozenset(
        {*MARKER_REASONS.values(), Reason.NOT_GIVEN_BY_QUEENSLAND_HEALTH}
    ),
    FigureState.NOT_REPORTED: frozenset({Reason.NOT_REPORTED_BY_SOURCE}),
}


def _finite_number(value: object) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(value)


@dataclass(frozen=True)
class Figure:
    column: str
    state: FigureState
    # Present only when published. A suppressed cell never holds 0 or any other stand-in.
    value: Number | None
    reason: Reason | None

    def __post_init__(self) -> None:
        allowed = ALLOWED_REASONS[self.state]
        if self.state is FigureState.PUBLISHED:
            ok = _finite_number(self.value) and self.reason is None
        else:
            ok = self.value is None and self.reason in allowed
        if not ok:
            msg = f"{self.column}: a {self.state.value} figure has the wrong value or reason"
            raise SuppressionError(msg)

    @property
    def display(self) -> str | None:
        """The words for a figure with no number; None for a published one."""
        if self.reason is None:
            return None
        if self.state is FigureState.NOT_REPORTED:
            return self.state.value
        return f"{self.state.value}: {REASON_TEXT[self.reason]}"

    @property
    def rankable(self) -> bool:
        return self.state is FigureState.PUBLISHED


@dataclass(frozen=True)
class SuppressedObservation:
    observation: Observation
    figures: tuple[Figure, ...]


@dataclass(frozen=True)
class SuppressedTable:
    observations: tuple[SuppressedObservation, ...]
    # Counts of published cells and of each reason, in a fixed order.
    counts: tuple[tuple[str, int], ...]


def _gap(where: str, text: str) -> str:
    return f"{where}: {text}"


def figure_for_cell(cell: Cell, where: str) -> Figure:
    """A Figure for one AIHW cell, or a SuppressionError saying why the cell is not valid."""
    where = f"{where} {cell.column}"
    if cell.marker is None:
        if cell.value is None:
            raise SuppressionError(_gap(where, "the value is null and carries no marker"))
        return Figure(cell.column, FigureState.PUBLISHED, cell.value, None)
    if cell.value is not None:
        raise SuppressionError(_gap(where, f"the marker {cell.marker!r} sits on a value"))
    reason = MARKER_REASONS.get(cell.marker)
    if reason is None:
        raise SuppressionError(_gap(where, f"unknown marker {cell.marker!r}"))
    if reason in PEER_GROUP_REASONS and cell.role is not None:
        raise SuppressionError(_gap(where, f"{cell.marker!r} appears outside a peer-group column"))
    return Figure(cell.column, FigureState.NOT_PUBLISHED, None, reason)


def suppress(result: WaitingTimes) -> SuppressedTable:
    """Every cell as a Figure, or one SuppressionError naming each cell that fails."""
    done: list[SuppressedObservation] = []
    problems: list[str] = []
    tally: Counter[str] = Counter()
    for o in result.observations:
        where = f"{result.table.value} {o.code} {o.category!r} {o.period}"
        figures: list[Figure] = []
        for cell in o.cells:
            try:
                figure = figure_for_cell(cell, where)
            except SuppressionError as err:
                problems.append(str(err))
                continue
            figures.append(figure)
            tally[figure.reason.value if figure.reason else FigureState.PUBLISHED.value] += 1
        done.append(SuppressedObservation(o, tuple(figures)))
    if problems:
        msg = f"{result.table.value}: {len(problems)} cells fail: " + "; ".join(problems[:20])
        raise SuppressionError(msg)
    order = [FigureState.PUBLISHED.value, *(r.value for r in Reason)]
    return SuppressedTable(tuple(done), tuple((k, tally[k]) for k in order if tally[k]))


def qld_figures(
    row: Mapping[str, object],
    columns: Sequence[str] = QLD_VALUE_COLUMNS,
    null_columns: frozenset[str] = QLD_NULL_COLUMNS,
) -> tuple[Figure, ...]:
    """Figures for one Queensland row, where the `suppressed` list names the nulled columns."""
    where = f"qld {row.get('facility_code')}"
    raw = row.get("suppressed")
    if raw is not None and not isinstance(raw, list):
        raise SuppressionError(_gap(where, "suppressed is not a list"))
    named = [str(n) for n in cast("list[object]", raw or [])]
    unknown = sorted(set(named) - set(columns))
    if unknown:
        raise SuppressionError(_gap(where, f"suppressed names {unknown}, not value columns"))
    missing = sorted(set(columns) - set(row))
    if missing:
        raise SuppressionError(_gap(where, f"the row lacks {missing}"))
    figures: list[Figure] = []
    for column in columns:
        value = row[column]
        flagged = column in named
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            raise SuppressionError(_gap(f"{where} {column}", "the value is not a number"))
        if flagged and value is not None:
            raise SuppressionError(_gap(f"{where} {column}", "flagged as suppressed with a value"))
        if flagged:
            figures.append(
                Figure(
                    column,
                    FigureState.NOT_PUBLISHED,
                    None,
                    Reason.NOT_GIVEN_BY_QUEENSLAND_HEALTH,
                )
            )
        elif value is not None:
            figures.append(Figure(column, FigureState.PUBLISHED, value, None))
        elif column in null_columns:
            figures.append(
                Figure(column, FigureState.NOT_REPORTED, None, Reason.NOT_REPORTED_BY_SOURCE)
            )
        else:
            raise SuppressionError(_gap(f"{where} {column}", "null and not flagged as suppressed"))
    return tuple(figures)
