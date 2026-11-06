import json
from collections.abc import Mapping
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
