import itertools
import json
from collections.abc import Callable, Mapping
from functools import cache
from pathlib import Path
from typing import TYPE_CHECKING, Any

import jsonschema
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

if TYPE_CHECKING:
    from jsonschema.exceptions import ValidationError

CONTRACT_DIR = Path(__file__).resolve().parents[3] / "contract"
SCHEMA_SUFFIX = ".schema.json"


class ContractError(Exception):
    pass


@cache
def _schemas(directory: Path) -> Mapping[str, Mapping[str, Any]]:
    found: dict[str, Mapping[str, Any]] = {}
    for path in sorted(directory.glob(f"*{SCHEMA_SUFFIX}")):
        found[path.name.removesuffix(SCHEMA_SUFFIX)] = json.loads(path.read_text(encoding="utf-8"))
    return found


@cache
def _registry(directory: Path) -> Registry[Any]:
    # Schemas refer to each other by $id, so every one is registered before any is used.
    resources = [
        (schema["$id"], Resource.from_contents(schema, DRAFT202012))
        for schema in _schemas(directory).values()
    ]
    return Registry[Any]().with_resources(resources)


@cache
def _validator(name: str, directory: Path) -> jsonschema.Draft202012Validator:
    schemas = _schemas(directory)
    if name not in schemas:
        msg = f"no schema named {name!r} in {directory.name}/"
        raise ContractError(msg)
    jsonschema.Draft202012Validator.check_schema(schemas[name])
    return jsonschema.Draft202012Validator(schemas[name], registry=_registry(directory))


def schema_names(directory: Path = CONTRACT_DIR) -> tuple[str, ...]:
    return tuple(_schemas(directory))


def _period_problem(periods: list[str], years: list[int]) -> str | None:
    if len(years) != len(periods):
        return f"{len(years)} points for {len(periods)} periods"
    if any(not period.startswith(str(y)) for period, y in zip(periods, years, strict=True)):
        return "a period does not start with its point's year"
    if any(int(period[5:7]) != (y + 1) % 100 for period, y in zip(periods, years, strict=True)):
        return "a period does not end the year after it starts"
    return None


def _series_problem(series: Mapping[str, Any]) -> str | None:
    points = series["points"]
    years = [p[0] for p in points]
    if problem := _period_problem(series["periods"], years):
        return problem
    if any(b <= a for a, b in itertools.pairwise(years)):
        return "years are not strictly increasing"
    if points[0][2] is not None:
        return "the first point has a change"
    # A hospital may skip a year, so periods need not be consecutive; a change then has no basis.
    for before, after in itertools.pairwise(points):
        if after[2] is not None and (before[1] is None or after[0] - before[0] != 1):
            return "a change sits without a published point in the year before"
    return None


def _trend_problem(document: Mapping[str, Any]) -> str | None:
    """The rules JSON Schema cannot express, as the first place a trend breaks them."""
    for i, series in enumerate(document["series"]):
        if problem := _series_problem(series):
            return f"series/{i}: {problem}"
    return None


_STATE_ORDER = ("NSW", "Vic", "Qld", "WA", "SA", "Tas", "ACT", "NT")


def _stamp_problem(measures: Mapping[str, Any] | None, period: str, release: str) -> str | None:
    for role, figure in (measures or {}).items():
        if figure["period"] != period or figure["release"] != release:
            return f"the {role} figure's period or release is not the page's"
    return None


def _benchmark_problem(document: Mapping[str, Any]) -> str | None:
    """A benchmark states the page's period and release, and its history has no gaps in change."""
    b = document["benchmarks"]
    where = "benchmarks"
    stamps = [("national", b["national"]), *((e["state"], e["measures"]) for e in b["states"])]
    for scope, measures in stamps:
        if problem := _stamp_problem(measures, document["period"], document["release"]):
            return f"{where}/{scope}: {problem}"
    scopes = [e["state"] for e in b["states"]]
    if len(scopes) != len(set(scopes)) or scopes != sorted(scopes, key=_STATE_ORDER.index):
        return f"{where}/states: a state is listed twice or out of order"
    keys = [(s["scope"], s["role"]) for s in b["trends"]]
    if len(keys) != len(set(keys)):
        return f"{where}/trends: a scope and role has two series"
    for i, series in enumerate(b["trends"]):
        if problem := _series_problem(series):
            return f"{where}/trends/{i}: {problem}"
    if document["kind"] == "urgency" and (b["national"] or scopes or b["trends"]):
        return f"{where}: the urgency table publishes no benchmark"
    return None


def _state_problem(document: Mapping[str, Any]) -> str | None:
    for i, row in enumerate(document["surgeries"]):
        for measures in (row["measures"], row["national"]):
            if problem := _stamp_problem(measures, row["period"], row["release"]):
                return f"surgeries/{i}: {problem}"
    return None


SEMANTIC_CHECKS: Mapping[str, Callable[[Mapping[str, Any]], str | None]] = {
    "trend": _trend_problem,
    "surgery": _benchmark_problem,
    "state": _state_problem,
}


def validate(name: str, document: Any, directory: Path = CONTRACT_DIR) -> None:  # noqa: ANN401
    """Raise ContractError, naming the first place `document` breaks the `name` schema."""
    errors: list[ValidationError] = sorted(
        _validator(name, directory).iter_errors(document),  # pyright: ignore[reportUnknownMemberType]
        key=lambda e: [str(p) for p in e.absolute_path],
    )
    if errors:
        where = "/".join(str(p) for p in errors[0].absolute_path) or "(root)"
        msg = f"{name} is invalid at {where}: {errors[0].message[:200]}"
        raise ContractError(msg)
    if name in SEMANTIC_CHECKS and (problem := SEMANTIC_CHECKS[name](document)):
        msg = f"{name} is invalid at {problem}"
        raise ContractError(msg)
