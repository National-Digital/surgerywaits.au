import json
from collections.abc import Mapping
from importlib import import_module
from pathlib import Path
from typing import Any, cast

from surgerywaits.manifest import Entry

# pyarrow ships no type stubs, so it is loaded dynamically and read only through read_metadata.
PQ: Any = import_module("pyarrow.parquet")


class MetadataError(Exception):
    pass


def read_metadata(path: Path) -> dict[str, Any]:
    found: dict[bytes, bytes] = PQ.read_schema(path).metadata or {}
    raw = found.get(b"publicdata")
    if raw is None:
        msg = f"{path.name}: the file carries no publicdata metadata"
        raise MetadataError(msg)
    try:
        return cast("dict[str, Any]", json.loads(raw))
    except ValueError as err:
        msg = f"{path.name}: the publicdata metadata is not JSON"
        raise MetadataError(msg) from err


def _expected(entry: Entry) -> dict[str, Any]:
    return {
        "dataset": entry.slug,
        "version": entry.version,
        "title": entry.title,
        "publisher.name": entry.publisher.name,
        "publisher.url": entry.publisher.url,
        "url": entry.url,
        "attribution": entry.attribution,
        "cite": entry.citation,
        "licence.id": entry.licence,
    }


def _found(meta: Mapping[str, Any]) -> dict[str, Any]:
    publisher = meta.get("publisher")
    licence = meta.get("licence")
    pub = cast("dict[str, Any]", publisher) if isinstance(publisher, dict) else {}
    lic = cast("dict[str, Any]", licence) if isinstance(licence, dict) else {}
    return {
        "dataset": meta.get("dataset"),
        "version": meta.get("version"),
        "title": meta.get("title"),
        "publisher.name": pub.get("name"),
        "publisher.url": pub.get("url"),
        "url": meta.get("url"),
        "attribution": meta.get("attribution"),
        "cite": meta.get("cite"),
        "licence.id": lic.get("id"),
    }


def check_metadata(entries: tuple[Entry, ...], files: Mapping[str, Path]) -> None:
    """The manifest's descriptive fields must say what publicdata.au wrote into each file."""
    for entry in entries:
        found = _found(read_metadata(files[entry.slug]))
        for field, want in _expected(entry).items():
            if found[field] != want:
                msg = f"{entry.slug}: manifest {field} differs from the file's publicdata metadata"
                raise MetadataError(msg)
