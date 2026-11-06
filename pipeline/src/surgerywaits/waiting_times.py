import itertools
import json
import re
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from importlib import import_module
from pathlib import Path
from typing import Any, Literal, cast

from surgerywaits.catalogue import Role
from surgerywaits.hospitals import Register
from surgerywaits.names import name_key

# pyarrow ships no type stubs, so it is loaded dynamically and read only through read_rows.
PQ: Any = import_module("pyarrow.parquet")

Row = Mapping[str, object]
MatchedBy = Literal["name", "alternative_name"]

HOSPITAL_LEVEL = "Hospital"
# Rows above hospital level carry no hospital name, so they are counted and left out.
OTHER_LEVELS = frozenset({"Local Hospital Network", "State", "National"})
PERIOD = re.compile(r"\d{4}\u2013\d{2}")
SUPPRESSED_LIST = "suppressed"
BASE_COLUMNS = ("reporting_unit", "reporting_unit_type", "state", "peer_group", "year", "markers")


class WaitingTimesError(Exception):
    pass


class Table(StrEnum):
    URGENCY = "urgency"
    PROCEDURE = "procedure"
    SPECIALTY = "specialty"


@dataclass(frozen=True)
class Column:
    name: str
    # None marks a peer-group column, which has no catalogue role of its own.
    role: Role | None
    integer: bool


@dataclass(frozen=True)
class Spec:
    category_column: str
    columns: tuple[Column, ...]


_SURGERIES = Column("surgeries", Role.VOLUME, integer=True)
_MEDIAN = Column("median_wait_days", Role.MEDIAN_WAIT, integer=True)
_PEER_MEDIAN = Column("peer_group_median_days", None, integer=True)
_PEER_AVERAGE = Column("peer_group_average", None, integer=False)

SPECS: dict[Table, Spec] = {
    Table.URGENCY: Spec(
        "urgency_category",
        (
            _SURGERIES,
            _MEDIAN,
            Column("share_within_recommended_time", Role.ON_TIME, integer=False),
            _PEER_MEDIAN,
            _PEER_AVERAGE,
        ),
    ),
    Table.PROCEDURE: Spec(
        "intended_procedure",
        (
            _SURGERIES,
            _MEDIAN,
            Column("share_waited_over_365_days", Role.LONG_WAIT, integer=False),
            _PEER_MEDIAN,
            _PEER_AVERAGE,
        ),
    ),
    Table.SPECIALTY: Spec(
        "surgical_specialty",
        (
            _SURGERIES,
            _MEDIAN,
            Column("share_waited_over_365_days", Role.LONG_WAIT, integer=False),
            _PEER_MEDIAN,
            _PEER_AVERAGE,
        ),
    ),
}


@dataclass(frozen=True)
class Cell:
    column: str
    role: Role | None
    # The raw published number, or None where the publisher emptied the cell.
    value: int | float | None
    # The publisher's code for this cell, kept verbatim and not interpreted here.
    marker: str | None


@dataclass(frozen=True)
class Observation:
    code: str
    published_name: str
    matched_by: MatchedBy
    period: str
    category: str
    peer_group: str | None
    cells: tuple[Cell, ...]


@dataclass(frozen=True)
class WaitingTimes:
    table: Table
    observations: tuple[Observation, ...]
    # Rows above hospital level that were left out, by level.
    other_levels: tuple[tuple[str, int], ...]


@dataclass(frozen=True)
class Match:
    code: str
    by: MatchedBy


class HospitalIndex:
    """Joins a published hospital name and state to a register code, or says why it cannot."""

    def __init__(self, register: Register) -> None:
        self._names: dict[tuple[str, str], set[str]] = {}
        self._aliases: dict[tuple[str, str], set[str]] = {}
        for h in register.hospitals:
            self._names.setdefault((h.state, name_key(h.name)), set()).add(h.code)
            for alias in h.alternative_names:
                self._aliases.setdefault((h.state, name_key(alias)), set()).add(h.code)

    def match(self, name: str, state: str) -> Match | str:
        """A Match, or the reason there is none."""
        key = (state, name_key(name))
        # A register name outranks another hospital's alias, as the register itself enforces.
        for found, by in ((self._names, "name"), (self._aliases, "alternative_name")):
            codes = found.get(key, set())
            if len(codes) == 1:
                return Match(next(iter(codes)), cast("MatchedBy", by))
            if codes:
                return f"ambiguous: the {by.replace('_', ' ')} fits {', '.join(sorted(codes))}"
        return "unmatched: no hospital in the register has this name in this state"


def read_rows(path: Path) -> list[Row]:
    try:
        table: Any = PQ.read_table(path)
    except OSError as err:
        msg = f"cannot read {path.name}: {err}"
        raise WaitingTimesError(msg) from err
    return cast("list[Row]", table.to_pylist())


def _text(row: Row, key: str, where: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value.strip():
        msg = f"{where}: {key} is missing"
        raise WaitingTimesError(msg)
    return value


def _number(row: Row, column: Column, where: str) -> int | float | None:
    value = row[column.name]
    if value is None:
        return None
    wanted = int if column.integer else float
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        msg = f"{where}: {column.name} is not a number"
        raise WaitingTimesError(msg)
    if column.integer and not isinstance(value, int):
        msg = f"{where}: {column.name} is not a whole number"
        raise WaitingTimesError(msg)
    return wanted(value)


def _markers(row: Row, columns: Sequence[Column], where: str) -> dict[str, str]:
    raw = row["markers"]
    if raw is None:
        return {}
    try:
        parsed: object = json.loads(cast("str", raw))
    except (TypeError, ValueError) as err:
        msg = f"{where}: markers are not JSON"
        raise WaitingTimesError(msg) from err
    if not isinstance(parsed, dict):
        msg = f"{where}: markers are not an object"
        raise WaitingTimesError(msg)
    found = cast("dict[object, object]", parsed)
    names = {c.name for c in columns}
    for column, code in found.items():
        if column not in names:
            msg = f"{where}: a marker names {column!r}, which is not a value column"
            raise WaitingTimesError(msg)
        if not isinstance(code, str) or not code:
            msg = f"{where}: the marker for {column!r} is not a code"
            raise WaitingTimesError(msg)
    return cast("dict[str, str]", found)


def _check_columns(rows: Sequence[Row], spec: Spec) -> None:
    expected = {
        *BASE_COLUMNS,
        SUPPRESSED_LIST,
        spec.category_column,
        *(c.name for c in spec.columns),
    }
    if not rows:
        msg = "the table has no rows"
        raise WaitingTimesError(msg)
    seen = set(rows[0])
    if seen != expected:
        msg = (
            f"the table's columns changed: missing {sorted(expected - seen)}, "
            f"unexpected {sorted(seen - expected)}"
        )
        raise WaitingTimesError(msg)


def _identity(o: Observation) -> tuple[str, str, str]:
    return o.code, o.category, o.period


def build(rows: Sequence[Row], table: Table, register: Register) -> WaitingTimes:
    """Every hospital row joined to a register code, or a WaitingTimesError naming each failure."""
    spec = SPECS[table]
    _check_columns(rows, spec)
    index = HospitalIndex(register)
    observations: list[Observation] = []
    failures: dict[tuple[str, str], str] = {}
    levels: Counter[str] = Counter()
    for i, row in enumerate(rows):
        where = f"{table.value} row {i}"
        level = _text(row, "reporting_unit_type", where)
        if level != HOSPITAL_LEVEL:
            if level not in OTHER_LEVELS:
                msg = f"{where}: unknown reporting unit type {level!r}"
                raise WaitingTimesError(msg)
            levels[level] += 1
            continue
        name, state = _text(row, "reporting_unit", where), _text(row, "state", where)
        found = index.match(name, state)
        if isinstance(found, str):
            failures[state, name] = found
            continue
        period = _text(row, "year", where)
        if not PERIOD.fullmatch(period):
            msg = f"{where}: {period!r} is not a reference period"
            raise WaitingTimesError(msg)
        peer = row["peer_group"]
        if peer is not None and not isinstance(peer, str):
            msg = f"{where}: peer_group is not text"
            raise WaitingTimesError(msg)
        markers = _markers(row, spec.columns, where)
        cells = tuple(
            Cell(c.name, c.role, _number(row, c, where), markers.get(c.name)) for c in spec.columns
        )
        observations.append(
            Observation(
                found.code,
                name,
                found.by,
                period,
                _text(row, spec.category_column, where),
                peer,
                cells,
            )
        )
    if failures:
        lines = [f"{n!r} ({s}): {why}" for (s, n), why in sorted(failures.items())]
        msg = f"{table.value}: {len(lines)} hospital names do not join: " + "; ".join(lines)
        raise WaitingTimesError(msg)
    ordered = sorted(observations, key=_identity)
    for before, after in itertools.pairwise(ordered):
        if _identity(before) == _identity(after):
            msg = (
                f"{table.value}: {after.code} has two rows for {after.category!r} "
                f"in {after.period} ({before.published_name!r} and {after.published_name!r})"
            )
            raise WaitingTimesError(msg)
    return WaitingTimes(table, tuple(ordered), tuple(sorted(levels.items())))


def load(path: Path, table: Table, register: Register) -> WaitingTimes:
    return build(read_rows(path), table, register)
