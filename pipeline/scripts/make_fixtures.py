"""Cut the test fixtures from pinned publicdata.au versions. Run by hand; CI never runs it.

    cd pipeline && uv run --locked python scripts/make_fixtures.py          # verify and rebuild
    cd pipeline && uv run --locked python scripts/make_fixtures.py --bump   # move to newer versions

By default each pinned version is fetched and its sha256 must equal the manifest's, or the run
aborts and leaves the fixtures untouched. Only --bump picks the newest version. publicdata's own
SHA256SUMS is recorded (match, stale or missing) and never fails the run. Nothing here reads
another source.
"""

import argparse
import hashlib
import json
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

BASE = "https://publicdata.au"
OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures"

# Hospitals chosen across NSW, Vic and Qld: one with every marker, one closed, one ordinary.
HOSPITALS = {
    "NSW": ["Armidale Hospital", "Bourke Multi Purpose Service", "Manly Hospital"],
    "Vic": [
        "Sunbury Day Hospital",
        "Victorian Heart Hospital",
        "Healesville Hospital and Yarra Valley Health",
    ],
    "Qld": [
        "Ayr Hospital",
        "Cooktown Hospital",
        "Mater Adult Hospital",
        "Royal Children's Hospital [Queensland]",
    ],
}
QLD_FACILITIES = ["Ayr", "Cooktown", "Mater Adult", "Cairns", "Thursday Island"]
STATE_NAMES = {"NSW": "New South Wales", "Vic": "Victoria", "Qld": "Queensland"}
KEEP_YEARS = 2
WAITS = "au-elective-surgery-waiting-times"
SLUGS = [
    WAITS,
    f"{WAITS}-by-procedure",
    f"{WAITS}-by-specialty",
    "au-myhospitals-reported-measures",
    "au-myhospitals-reporting-units",
    "au-myhospitals-reporting-unit-mappings",
    "au-hospitals-myhospitals",
    "qld-elective-surgery-by-category",
    "qld-elective-surgery-by-specialty",
    "abs-suburbs-localities-2021",
]
CATEGORY_COLUMNS = ["urgency_category", "intended_procedure", "surgical_specialty"]


def fetch(url: str, dest: Path | None = None) -> bytes:
    if not url.startswith(BASE + "/"):
        msg = f"refusing a source outside {BASE}: {url}"
        raise SystemExit(msg)
    request = urllib.request.Request(url, headers={"User-Agent": "surgerywaits-fixtures"})  # noqa: S310
    with urllib.request.urlopen(request, timeout=120) as resp:  # noqa: S310
        if dest is None:
            return resp.read()
        with dest.open("wb") as fh:
            shutil.copyfileobj(resp, fh)
        return b""


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def publisher_sums(vurl: str) -> dict[str, str]:
    try:
        text = fetch(f"{vurl}/SHA256SUMS").decode("utf-8")
    except urllib.error.HTTPError as err:
        if err.code != 404:  # noqa: PLR2004
            raise
        return {}
    return {m[2]: m[1] for m in re.finditer(r"^([0-9a-f]{64})  (\S+)$", text, re.MULTILINE)}


def newest(slug: str) -> str:
    listing = json.loads(fetch(f"{BASE}/api/v1/datasets/{slug}/versions"))
    return max(v["version"] for v in listing["versions"])


def download(slug: str, version: str, tmp: Path) -> tuple[Path, str]:
    path = tmp / f"{slug}.parquet"
    fetch(f"{BASE}/d/{slug}/v/{version}/data.parquet", path)
    return path, sha256(path)


def sum_status(slug: str, version: str, actual: str) -> str:
    """How publicdata's own sum compares; it is recorded and never fails the run."""
    published = publisher_sums(f"{BASE}/d/{slug}/v/{version}").get(f"{slug}_{version}.parquet")
    if published is None:
        return "missing"
    return "match" if published == actual else "stale"


def take(table: pa.Table, keep: list[bool]) -> pa.Table:
    return table.filter(pa.array(keep))


def years_to_keep(table: pa.Table, names: set[str]) -> dict[str, set[str]]:
    seen: dict[str, set[str]] = {}
    for unit, year in zip(
        table["reporting_unit"].to_pylist(), table["year"].to_pylist(), strict=True
    ):
        if unit in names:
            seen.setdefault(unit, set()).add(year)
    return {unit: set(sorted(years)[-KEEP_YEARS:]) for unit, years in seen.items()}


def cut_waits(table: pa.Table, names: set[str]) -> pa.Table:
    newest = years_to_keep(table, names)
    rows = zip(
        table["reporting_unit"].to_pylist(),
        table["year"].to_pylist(),
        table["markers"].to_pylist(),
        strict=True,
    )
    keep = [u in names and (y in newest[u] or m is not None) for u, y, m in rows]
    return take(table, keep)


def sort_by(table: pa.Table, columns: list[str]) -> pa.Table:
    return table.sort_by([(c, "ascending") for c in columns])


def cut(slug: str, table: pa.Table, ctx: dict[str, Any]) -> pa.Table:  # noqa: PLR0911
    names: set[str] = ctx["names"]
    cols = set(table.column_names)
    if slug.startswith(WAITS):
        out = cut_waits(table, names)
        ctx["categories"] |= {v for c in CATEGORY_COLUMNS if c in cols for v in out[c].to_pylist()}
        return sort_by(out, ["reporting_unit", *[c for c in CATEGORY_COLUMNS if c in cols], "year"])
    if slug == "au-myhospitals-reporting-units":
        out = take(table, [n in names for n in table["name"].to_pylist()])
        ctx["codes"] = set(out["code"].to_pylist())
        return sort_by(out, ["code"])
    if slug == "au-hospitals-myhospitals":
        return sort_by(
            take(table, [c in ctx["codes"] for c in table["code"].to_pylist()]), ["code"]
        )
    if slug == "au-myhospitals-reporting-unit-mappings":
        out = take(table, [c in ctx["codes"] for c in table["reporting_unit_code"].to_pylist()])
        return sort_by(out, ["reporting_unit_code", "map_type_code", "mapped_code"])
    if slug == "au-myhospitals-reported-measures":
        out = take(table, [c in ctx["categories"] for c in table["category_name"].to_pylist()])
        return sort_by(out, ["reported_measure_code"])
    if slug.startswith("qld-"):
        out = take(table, [f in QLD_FACILITIES for f in table["facility"].to_pylist()])
        return sort_by(
            out, [c for c in ["facility_code", "category", "specialty_code"] if c in cols]
        )
    if slug == "abs-suburbs-localities-2021":
        words = {
            (STATE_NAMES[s], w)
            for s, hs in HOSPITALS.items()
            for h in hs
            for w in re.findall(r"[A-Za-z]+", h)
        }
        keep = [
            (state, name) in words
            for state, name in zip(
                table["state_name"].to_pylist(), table["sal_2021_name"].to_pylist(), strict=True
            )
        ]
        return sort_by(take(table, keep).drop_columns(["geometry"]), ["sal_2021_code"])
    msg = f"no cut defined for {slug}"
    raise SystemExit(msg)


def markers_in(table: pa.Table) -> list[str]:
    if "markers" not in table.column_names:
        return []
    found: set[str] = set()
    for raw in table["markers"].to_pylist():
        if raw is not None:
            found |= set(json.loads(raw).values())
    return sorted(found)


def marker_form(table: pa.Table) -> str:
    for form in ("markers", "suppressed"):
        if form in table.column_names:
            return form
    return "none"


def load_pins() -> dict[str, Any]:
    path = OUT / "manifest.json"
    if not path.is_file():
        msg = "no manifest to verify against; run with --bump to create one"
        raise SystemExit(msg)
    return json.loads(path.read_text(encoding="utf-8"))


def build_slug(slug: str, tmp: Path, pins: dict[str, Any], *, bump: bool) -> tuple[str, str, Path]:
    """Fetch and verify one dataset. Return its version, sha256 and file."""
    pin = pins.get(slug)
    version = newest(slug) if bump or pin is None else pin["version"]
    path, digest = download(slug, version, tmp)
    if pin and pin["version"] == version and pin["source_sha256"] != digest:
        msg = (
            f"{slug} {version}: served sha256 {digest} "
            f"differs from the pinned {pin['source_sha256']}"
        )
        raise SystemExit(msg)
    return version, digest, path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bump", action="store_true", help="move each pin to the newest version")
    bump = parser.parse_args().bump
    pins = load_pins() if (OUT / "manifest.json").is_file() or not bump else {}
    names = {h for hs in HOSPITALS.values() for h in hs}
    ctx: dict[str, Any] = {"names": names, "codes": set(), "categories": set()}
    manifest: dict[str, Any] = {}
    with tempfile.TemporaryDirectory() as tmpname:
        tmp = Path(tmpname)
        built = tmp / "built"
        for slug in SLUGS:
            version, digest, path = build_slug(slug, tmp, pins, bump=bump)
            table = pq.read_table(path)
            meta = json.loads((table.schema.metadata or {})[b"publicdata"])
            out = cut(slug, table, ctx)
            if out.num_rows == 0:
                msg = f"{slug}: the extract is empty"
                raise SystemExit(msg)
            dest = built / slug / "data.parquet"
            dest.parent.mkdir(parents=True)
            pq.write_table(out, dest, compression="zstd", compression_level=19)
            pin = pins.get(slug)
            same = bool(pin) and pin["version"] == version
            manifest[slug] = {
                "attribution": meta["attribution"],
                "cite": meta["cite"],
                "extract": f"{slug}/data.parquet",
                "extract_rows": out.num_rows,
                "extract_sha256": sha256(dest),
                "licence": meta["licence"]["id"],
                "marker_form": marker_form(out),
                "markers": markers_in(out),
                "publisher_sum": pin["publisher_sum"]
                if same
                else sum_status(slug, version, digest),
                "publisher": meta["publisher"]["name"],
                "source_rows": table.num_rows,
                "source_sha256": digest,
                "source_url": f"{BASE}/d/{slug}/v/{version}/data.parquet",
                "version": version,
            }
            if pin and not bump and pin["extract_sha256"] != manifest[slug]["extract_sha256"]:
                msg = (
                    f"{slug}: the extract no longer matches its pinned sha256; use --bump to accept"
                )
                raise SystemExit(msg)
            if pin and pin["version"] != version:
                print(f"{slug}: {pin['version']} -> {version}")
            elif pin and pin["extract_sha256"] != manifest[slug]["extract_sha256"]:
                print(f"{slug}: {version} extract changed")
            else:
                print(f"{slug}: {version} unchanged" if pin else f"{slug}: {version} new")
        text = json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        (built / "manifest.json").write_text(text, encoding="utf-8")
        shutil.rmtree(OUT, ignore_errors=True)
        shutil.copytree(built, OUT)


if __name__ == "__main__":
    sys.exit(main())
