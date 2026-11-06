"""Cut the test fixtures from pinned publicdata.au versions. Run by hand; CI never runs it.

    cd pipeline && uv run --locked python scripts/make_fixtures.py          # verify and rebuild
    cd pipeline && uv run --locked python scripts/make_fixtures.py --bump   # move to newer versions
    cd pipeline && uv run --locked python scripts/make_fixtures.py --recut  # new cut, same versions

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

# Hospitals chosen across NSW, Vic, Qld and the ACT: one with every marker, one closed, one
# ordinary, two sharing the alias "Wollongong", a hospital published under a new name beside its
# old one, and a hospital whose name a network also carries.
HOSPITALS = {
    "ACT": [
        "North Canberra Hospital",
        "North Canberra Hospital (previously known as Calvary Public Hospital Bruce)",
    ],
    "NSW": [
        "Armidale Hospital",
        "Bourke Multi Purpose Service",
        "Bulli Hospital",
        "Manly Hospital",
        "Wollongong Hospital",
    ],
    "Vic": [
        "Northeast Health Wangaratta",
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
# Two campuses that share the alias "WDHS", so the register's shared-alias rule has real rows.
SHARED_ALIAS_PAIR = [
    "Western District Health Service [Hamilton]",
    "Western District Health Service [Penshurst]",
]
NATIONAL = "NAT"
# Noosa has no public hospital in the register, and the state total is not a facility.
QLD_FACILITIES = [
    "Ayr",
    "Cooktown",
    "Mater Adult",
    "Cairns",
    "Thursday Island",
    "Noosa",
    "Queensland Reporting Hospitals",
]
STATE_NAMES = {
    "ACT": "Australian Capital Territory",
    "NSW": "New South Wales",
    "Vic": "Victoria",
    "Qld": "Queensland",
}
# Each kept state, and the national row, with a state benchmark beside the national one.
BENCHMARK_STATES = {NATIONAL, *STATE_NAMES}
BENCHMARK_LEVELS = {"State", "National"}
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
# Two same-named suburbs the ABS qualifies by state, three whose area centroid falls outside the
# shape (one in two parts), and the special-purpose rows with no shape.
SUBURB_CODES = {"10003", "20002", "60007", "60071", "60380", "19494", "19797", "ZZZZZ"}
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
    hospitals = take(table, keep)
    return pa.concat_tables([hospitals, cut_benchmarks(table, hospitals)])


def cut_benchmarks(table: pa.Table, hospitals: pa.Table) -> pa.Table:
    """State and national rows for the kept categories, in the table's two newest years."""
    column = next(c for c in CATEGORY_COLUMNS if c in table.column_names)
    categories = set(hospitals[column].to_pylist())
    levels = table["reporting_unit_type"].to_pylist()
    scopes = table["state"].to_pylist()
    kinds = table[column].to_pylist()
    years = table["year"].to_pylist()
    newest = set(
        sorted({y for y, k in zip(years, levels, strict=True) if k in BENCHMARK_LEVELS})[
            -KEEP_YEARS:
        ]
    )
    keep = [
        k in BENCHMARK_LEVELS and s in BENCHMARK_STATES and c in categories and y in newest
        for k, s, c, y in zip(levels, scopes, kinds, years, strict=True)
    ]
    return take(table, keep)


def sort_by(table: pa.Table, columns: list[str]) -> pa.Table:
    return table.sort_by([(c, "ascending") for c in columns])


def plan_register(
    units: pa.Table, mappings: pa.Table, names: set[str]
) -> tuple[set[str], set[str]]:
    """Hospital codes to keep, and the state, network and national units they map to."""
    hospitals = {
        c
        for c, n, t in zip(
            units["code"].to_pylist(),
            units["name"].to_pylist(),
            units["type_code"].to_pylist(),
            strict=True,
        )
        if n in names and t == "H"
    }
    related = {NATIONAL}
    for unit, mapped in zip(
        mappings["reporting_unit_code"].to_pylist(),
        mappings["mapped_code"].to_pylist(),
        strict=True,
    ):
        if unit in hospitals:
            related.add(mapped)
    return hospitals, related - hospitals


def cut(slug: str, table: pa.Table, ctx: dict[str, Any]) -> pa.Table:  # noqa: PLR0911
    names: set[str] = ctx["names"]
    cols = set(table.column_names)
    if slug.startswith(WAITS):
        out = cut_waits(table, names)
        ctx["categories"] |= {v for c in CATEGORY_COLUMNS if c in cols for v in out[c].to_pylist()}
        return sort_by(out, ["reporting_unit", *[c for c in CATEGORY_COLUMNS if c in cols], "year"])
    if slug == "au-myhospitals-reporting-units":
        out = take(table, [c in ctx["codes"] | ctx["related"] for c in table["code"].to_pylist()])
        return sort_by(out, ["code"])
    if slug == "au-hospitals-myhospitals":
        keep = ctx["codes"] | ctx["related"]
        return sort_by(take(table, [c in keep for c in table["code"].to_pylist()]), ["code"])
    if slug == "au-myhospitals-reporting-unit-mappings":
        # Non-hospital units keep only rows that point at a kept unit, duplicates included.
        everything = ctx["codes"] | ctx["related"]
        keep = [
            (u in ctx["codes"]) or (u in ctx["related"] and m in everything)
            for u, m in zip(
                table["reporting_unit_code"].to_pylist(),
                table["mapped_code"].to_pylist(),
                strict=True,
            )
        ]
        return sort_by(take(table, keep), ["reporting_unit_code", "map_type_code", "mapped_code"])
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
            (state, name) in words or code in SUBURB_CODES
            for state, name, code in zip(
                table["state_name"].to_pylist(),
                table["sal_2021_name"].to_pylist(),
                table["sal_2021_code"].to_pylist(),
                strict=True,
            )
        ]
        return sort_by(take(table, keep), ["sal_2021_code"])
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
    parser.add_argument(
        "--recut", action="store_true", help="accept a changed extract at the pinned versions"
    )
    args = parser.parse_args()
    bump, recut = args.bump, args.recut
    pins = load_pins() if (OUT / "manifest.json").is_file() or not bump else {}
    names = {h for hs in HOSPITALS.values() for h in hs}
    ctx: dict[str, Any] = {"names": names, "codes": set(), "related": set(), "categories": set()}
    manifest: dict[str, Any] = {}
    with tempfile.TemporaryDirectory() as tmpname:
        tmp = Path(tmpname)
        built = tmp / "built"
        fetched = {slug: build_slug(slug, tmp, pins, bump=bump) for slug in SLUGS}
        ctx["codes"], ctx["related"] = plan_register(
            pq.read_table(fetched["au-myhospitals-reporting-units"][2]),
            pq.read_table(fetched["au-myhospitals-reporting-unit-mappings"][2]),
            names | set(SHARED_ALIAS_PAIR),
        )
        for slug in SLUGS:
            version, digest, path = fetched[slug]
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
                "publisher_url": meta["publisher"]["url"],
                "source_rows": table.num_rows,
                "source_sha256": digest,
                "source_url": f"{BASE}/d/{slug}/v/{version}/data.parquet",
                "title": meta["title"],
                "version": version,
            }
            if (
                pin
                and not (bump or recut)
                and pin["extract_sha256"] != manifest[slug]["extract_sha256"]
            ):
                msg = f"{slug}: the extract differs from its pin; use --bump or --recut"
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
