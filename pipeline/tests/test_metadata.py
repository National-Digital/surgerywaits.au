import json
import re
from dataclasses import replace
from importlib import import_module
from pathlib import Path
from typing import Any

import pytest

import realdata
from fakes import make_entry
from surgerywaits.manifest import Entry, Publisher, load
from surgerywaits.metadata import MetadataError, check_metadata

# pyarrow ships no type stubs.
pa: Any = import_module("pyarrow")
pq: Any = import_module("pyarrow.parquet")
ENTRY = make_entry()


def _file(tmp_path: Path, meta: dict[str, object] | None) -> dict[str, Path]:
    table = pa.table({"a": [1]})
    if meta is not None:
        table = table.replace_schema_metadata({"publicdata": json.dumps(meta)})
    path = tmp_path / "f.parquet"
    pq.write_table(table, path)
    return {ENTRY.slug: path}


def _meta(entry: Entry = ENTRY) -> dict[str, object]:
    return {
        "dataset": entry.slug,
        "version": entry.version,
        "title": entry.title,
        "publisher": {"name": entry.publisher.name, "url": entry.publisher.url},
        "url": entry.url,
        "attribution": entry.attribution,
        "cite": entry.citation,
        "licence": {"id": entry.licence},
    }


def test_a_manifest_that_agrees_with_the_file_passes(tmp_path: Path) -> None:
    check_metadata((ENTRY,), _file(tmp_path, _meta()))


@pytest.mark.parametrize(
    ("over", "field"),
    [
        ({"title": "Other"}, "title"),
        ({"publisher": {"name": "Other", "url": ENTRY.publisher.url}}, "publisher.name"),
        (
            {"publisher": {"name": ENTRY.publisher.name, "url": "https://o.example/"}},
            "publisher.url",
        ),
        ({"cite": "Other."}, "cite"),
        ({"version": "2020-01-01"}, "version"),
        ({"publisher": "not an object"}, "publisher.name"),
    ],
)
def test_a_field_that_differs_from_the_file_is_caught(
    tmp_path: Path, over: dict[str, object], field: str
) -> None:
    with pytest.raises(MetadataError, match=re.escape(field)):
        check_metadata((ENTRY,), _file(tmp_path, _meta() | over))


def test_a_file_without_metadata_is_caught(tmp_path: Path) -> None:
    with pytest.raises(MetadataError, match="no publicdata metadata"):
        check_metadata((ENTRY,), _file(tmp_path, None))


def test_an_entry_with_another_publisher_is_caught(tmp_path: Path) -> None:
    drifted = replace(ENTRY, publisher=Publisher(name="Other", url=ENTRY.publisher.url))
    with pytest.raises(MetadataError, match=r"publisher\.name"):
        check_metadata((drifted,), _file(tmp_path, _meta()))


def test_the_pinned_files_agree_with_the_manifest() -> None:
    entries = load()
    paths = realdata.pinned(*(e.slug for e in entries))
    check_metadata(entries, {e.slug: p for e, p in zip(entries, paths, strict=True)})
