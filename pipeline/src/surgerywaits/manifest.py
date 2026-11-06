import json
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

import jsonschema

if TYPE_CHECKING:
    from jsonschema.exceptions import ValidationError

ROOT = Path(__file__).resolve().parents[3]
MANIFEST_PATH = ROOT / "data" / "manifest.json"
SCHEMA_PATH = ROOT / "contract" / "manifest.schema.json"
URL_FORM = re.compile(r"https://publicdata\.au/d/([^/]+)/v/([^/]+)/data\.parquet")


class ManifestError(Exception):
    pass


@dataclass(frozen=True)
class Entry:
    slug: str
    version: str
    release: str | None
    as_at: str | None
    licence: str
    attribution: str
    citation: str
    url: str
    sha256: str


def _read_json(path: Path) -> Any:  # noqa: ANN401
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        msg = f"cannot read {path.name}: {err}"
        raise ManifestError(msg) from err


def _entry(raw: dict[str, Any]) -> Entry:
    entry = Entry(**raw)
    try:
        for value in (entry.version, entry.as_at):
            if value is not None:
                date.fromisoformat(value)
    except ValueError as err:
        msg = f"{entry.slug}: not a calendar date: {err}"
        raise ManifestError(msg) from err
    found = URL_FORM.fullmatch(entry.url)
    if found is None or found.groups() != (entry.slug, entry.version):
        msg = f"{entry.slug}: url does not name its own slug and version"
        raise ManifestError(msg)
    return entry


def load(path: Path = MANIFEST_PATH, schema_path: Path = SCHEMA_PATH) -> tuple[Entry, ...]:
    schema: dict[str, Any] = _read_json(schema_path)
    document: dict[str, Any] = _read_json(path)
    validator = jsonschema.Draft202012Validator(schema)
    errors: list[ValidationError] = sorted(
        validator.iter_errors(document),  # pyright: ignore[reportUnknownMemberType]
        key=lambda e: list(e.absolute_path),
    )
    if errors:
        where = "/".join(str(p) for p in errors[0].absolute_path) or "(root)"
        msg = f"{path.name} is invalid at {where}: {errors[0].message}"
        raise ManifestError(msg)
    entries = tuple(_entry(raw) for raw in cast("list[dict[str, Any]]", document["datasets"]))
    slugs = [e.slug for e in entries]
    dupes = sorted({s for s in slugs if slugs.count(s) > 1})
    if dupes:
        msg = f"duplicate slug: {', '.join(dupes)}"
        raise ManifestError(msg)
    return entries
