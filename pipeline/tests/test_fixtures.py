import hashlib
import json
import shutil
from importlib import import_module
from pathlib import Path
from typing import Any, cast

# pyarrow ships no type stubs, so it is loaded dynamically and read only through this helper.
PQ: Any = import_module("pyarrow.parquet")
FIXTURES = Path(__file__).resolve().parent / "fixtures"
REASONS = {"<5": "too few patients", "-": "no patients reported", "NP": "not published"}
FORMS = {"markers", "suppressed", "none"}
SUMS = {"match", "stale", "missing"}
SLUGS = {
    "abs-suburbs-localities-2021",
    "au-elective-surgery-waiting-times",
    "au-elective-surgery-waiting-times-by-procedure",
    "au-elective-surgery-waiting-times-by-specialty",
    "au-hospitals-myhospitals",
    "au-myhospitals-reported-measures",
    "au-myhospitals-reporting-unit-mappings",
    "au-myhospitals-reporting-units",
    "qld-elective-surgery-by-category",
    "qld-elective-surgery-by-specialty",
}


def parquet_info(path: Path) -> tuple[list[str], int, list[str | None]]:
    """Column names, row count and the `markers` column (empty when absent)."""
    table: Any = PQ.read_table(path)
    names = cast("list[str]", table.column_names)
    markers = cast("list[str | None]", table["markers"].to_pylist()) if "markers" in names else []
    return names, cast("int", table.num_rows), markers


def _manifest(root: Path) -> dict[str, dict[str, Any]]:
    return cast(
        "dict[str, dict[str, Any]]", json.loads((root / "manifest.json").read_text("utf-8"))
    )


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def hash_mismatches(root: Path) -> list[str]:
    return [
        slug
        for slug, entry in sorted(_manifest(root).items())
        if digest(root / entry["extract"]) != entry["extract_sha256"]
    ]


def incomplete_entries(root: Path) -> list[str]:
    return [
        slug
        for slug, entry in sorted(_manifest(root).items())
        if not (entry.get("version") and entry.get("attribution") and entry.get("cite"))
    ]


def marker_codes(root: Path) -> set[str]:
    found: set[str] = set()
    for entry in _manifest(root).values():
        markers = parquet_info(root / entry["extract"])[2]
        for raw in markers:
            if raw is not None:
                found |= set(cast("dict[str, str]", json.loads(raw)).values())
    return found


def test_every_dataset_has_an_entry() -> None:
    assert set(_manifest(FIXTURES)) == SLUGS


def test_each_extract_matches_its_manifest_hash() -> None:
    assert hash_mismatches(FIXTURES) == []


def test_each_entry_has_a_version_and_attribution() -> None:
    assert incomplete_entries(FIXTURES) == []


def test_each_entry_records_how_it_was_pinned() -> None:
    for slug, entry in _manifest(FIXTURES).items():
        assert len(entry["source_sha256"]) == 64, slug
        assert entry["publisher_sum"] in SUMS, slug
        assert entry["marker_form"] in FORMS, slug
        assert entry["source_url"].endswith(f"/v/{entry['version']}/data.parquet"), slug
        assert entry["extract_rows"] == parquet_info(FIXTURES / entry["extract"])[1]


def test_every_marker_reason_is_represented() -> None:
    assert set(REASONS) <= marker_codes(FIXTURES)


def test_each_marker_form_matches_the_columns() -> None:
    for slug, entry in _manifest(FIXTURES).items():
        columns = parquet_info(FIXTURES / entry["extract"])[0]
        expected = next((f for f in ("markers", "suppressed") if f in columns), "none")
        assert entry["marker_form"] == expected, slug


def test_the_check_fails_on_a_tampered_copy(tmp_path: Path) -> None:
    root = tmp_path / "fixtures"
    shutil.copytree(FIXTURES, root)
    assert hash_mismatches(root) == []
    victim = root / "qld-elective-surgery-by-category" / "data.parquet"
    victim.write_bytes(victim.read_bytes() + b"x")
    assert hash_mismatches(root) == ["qld-elective-surgery-by-category"]


def test_the_check_fails_on_a_missing_attribution(tmp_path: Path) -> None:
    root = tmp_path / "fixtures"
    shutil.copytree(FIXTURES, root)
    manifest = _manifest(root)
    manifest["abs-suburbs-localities-2021"]["attribution"] = ""
    del manifest["au-hospitals-myhospitals"]["version"]
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert incomplete_entries(root) == ["abs-suburbs-localities-2021", "au-hospitals-myhospitals"]
