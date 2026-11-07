import re
from collections import defaultdict
from dataclasses import dataclass
from enum import StrEnum
from importlib import import_module
from pathlib import Path
from typing import Any, cast

# pyarrow ships no type stubs, so it is loaded dynamically and read only through this module.
PQ: Any = import_module("pyarrow.parquet")

COLUMNS = (
    "reported_measure_code",
    "reported_measure_name",
    "measure_code",
    "measure_name",
    "units",
    "category_code",
    "category_name",
    "category_type_code",
    "category_type_name",
)
# The catch-all stands for every surgery the publisher does not name, so it cannot be compared.
CATCH_ALL_CODES = frozenset({"ES_I888_OtherProcedure"})
# Separators are flattened first; "Other surgery" (a specialty) stays in scope on purpose.
SEPARATORS = re.compile(r"[\s_\-(),;:/]+")
CATCH_ALL_NAME = re.compile(
    r"\b(?:other|all)\b.*\bprocedures?\b|\bprocedures?\b.*\b(?:other|all)\b", re.IGNORECASE
)


class CatalogueError(Exception):
    pass


class Role(StrEnum):
    MEDIAN_WAIT = "median_wait"
    VOLUME = "volume"
    LONG_WAIT = "long_wait"
    ON_TIME = "on_time"


@dataclass(frozen=True)
class Expected:
    role: Role
    name: str
    unit: str


# The long-wait measure counts patients who waited longer than this many days.
LONG_WAIT_DAYS = 365


# The only hand-written part: which publisher measure plays which role, and what it must say.
MAPPINGS: dict[str, Expected] = {
    "MYH0009": Expected(Role.MEDIAN_WAIT, "Median waiting time for elective surgery", "days"),
    "MYH0006": Expected(Role.VOLUME, "Number of elective surgeries", "surgeries"),
    "MYH0007": Expected(
        Role.LONG_WAIT,
        f"Percentage of patients who waited longer than {LONG_WAIT_DAYS} days for elective surgery",
        "percent",
    ),
    "MYH0008": Expected(
        Role.ON_TIME,
        "Percentage of patients who received their surgery within clinically recommended times",
        "percent",
    ),
}


_WAITS = frozenset({Role.MEDIAN_WAIT, Role.VOLUME, Role.LONG_WAIT})
# Procedure and specialty categories publish a long wait share; urgency categories publish on-time.
ALLOWED_ROLES: dict[str, frozenset[Role]] = {
    "ES_IP": _WAITS,
    "ES_SS": _WAITS,
    "ES_URGENCY": frozenset({Role.MEDIAN_WAIT, Role.VOLUME, Role.ON_TIME}),
}


@dataclass(frozen=True)
class Measure:
    code: str
    name: str
    unit: str
    role: Role


@dataclass(frozen=True)
class Reported:
    role: Role
    code: str
    name: str


@dataclass(frozen=True)
class Category:
    code: str
    name: str
    type_code: str
    type_name: str
    reported: tuple[Reported, ...]


@dataclass(frozen=True)
class Catalogue:
    measures: tuple[Measure, ...]
    categories: tuple[Category, ...]
    excluded: tuple[Category, ...]


Row = dict[str, str]


def read_rows(path: Path) -> list[Row]:
    """Every row of a reported-measures file as strings, failing on a missing or null column."""
    table: Any = PQ.read_table(path)
    names = cast("list[str]", table.column_names)
    missing = [c for c in COLUMNS if c not in names]
    if missing:
        msg = f"reported measures lack columns {missing}"
        raise CatalogueError(msg)
    columns = {c: cast("list[str | None]", table[c].to_pylist()) for c in COLUMNS}
    rows: list[Row] = []
    for i in range(cast("int", table.num_rows)):
        row = {c: (columns[c][i] or "").strip() for c in COLUMNS}
        empty = [c for c, v in row.items() if not v]
        if empty:
            msg = f"reported measures row {i} has no value for {empty}"
            raise CatalogueError(msg)
        rows.append(row)
    return rows


def _is_catch_all(row: Row) -> bool:
    return row["category_code"] in CATCH_ALL_CODES


def _measures(rows: list[Row]) -> tuple[Measure, ...]:
    seen: dict[str, set[tuple[str, str]]] = defaultdict(set)
    for row in rows:
        seen[row["measure_code"]].add((row["measure_name"], row["units"]))
    found: list[Measure] = []
    for code, expected in sorted(MAPPINGS.items()):
        if code not in seen:
            msg = f"measure {code} ({expected.role}) is missing from the catalogue"
            raise CatalogueError(msg)
        if seen[code] != {(expected.name, expected.unit)}:
            msg = (
                f"measure {code} ({expected.role}) changed: expected "
                f"{expected.name!r} in {expected.unit!r}, found {sorted(seen[code])}"
            )
            raise CatalogueError(msg)
        found.append(Measure(code, expected.name, expected.unit, expected.role))
    return tuple(sorted(found, key=lambda m: m.role.value))


def _validate(code: str, group: list[Row]) -> tuple[list[Role], frozenset[Role]]:
    first = group[0]
    identities = {
        (r["category_name"], r["category_type_code"], r["category_type_name"]) for r in group
    }
    if len(identities) != 1:
        msg = f"category {code} is described more than one way: {sorted(identities)}"
        raise CatalogueError(msg)
    allowed = ALLOWED_ROLES.get(first["category_type_code"])
    if allowed is None:
        msg = f"category {code} has an unknown type {first['category_type_code']!r}"
        raise CatalogueError(msg)
    roles = [MAPPINGS[r["measure_code"]].role for r in group]
    if len(set(roles)) != len(roles):
        msg = f"category {code} reports a measure role more than once"
        raise CatalogueError(msg)
    if not set(roles) <= allowed:
        msg = f"category {code} reports roles outside its type: {sorted(set(roles) - allowed)}"
        raise CatalogueError(msg)
    return roles, allowed


def _categories(rows: list[Row]) -> tuple[list[Category], list[Category]]:
    grouped: dict[str, list[Row]] = defaultdict(list)
    for row in rows:
        if row["measure_code"] in MAPPINGS:
            grouped[row["category_code"]].append(row)
    kept: list[Category] = []
    excluded: list[Category] = []
    for code, group in sorted(grouped.items()):
        roles, allowed = _validate(code, group)
        first = group[0]
        reported = tuple(
            sorted(
                (
                    Reported(
                        MAPPINGS[r["measure_code"]].role,
                        r["reported_measure_code"],
                        r["reported_measure_name"],
                    )
                    for r in group
                ),
                key=lambda p: p.role.value,
            )
        )
        if frozenset(roles) != allowed:
            absent = sorted(r.value for r in allowed - set(roles))
            msg = f"category {code} does not publish every role of its type: lacks {absent}"
            raise CatalogueError(msg)
        category = Category(
            code,
            first["category_name"],
            first["category_type_code"],
            first["category_type_name"],
            reported,
        )
        if _is_catch_all(first):
            excluded.append(category)
        elif CATCH_ALL_NAME.search(SEPARATORS.sub(" ", first["category_name"])):
            msg = f"category {code} ({first['category_name']!r}) looks like a catch-all procedure"
            raise CatalogueError(msg)
        else:
            kept.append(category)
    return kept, excluded


def build(rows: list[Row]) -> Catalogue:
    """The catalogue of in-scope categories and measures, or a CatalogueError."""
    measures = _measures(rows)
    kept, excluded = _categories(rows)
    return Catalogue(measures, tuple(kept), tuple(excluded))


def load(path: Path) -> Catalogue:
    return build(read_rows(path))
