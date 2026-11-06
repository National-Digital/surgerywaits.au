"""Compare a built dist with the previous site's built data and list every difference.

Run by hand: the baseline is not in this repository, so CI never runs it.

    uv run python scripts/parity.py NEW_DIST BASELINE_DIR [-o REPORT.json]
"""

import argparse
import json
import math
import statistics
import sys
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

Doc = dict[str, Any]
Key = tuple[str, str, str, str]  # hospital code, category code, period, role

PERCENT_ROLES = {"long_wait": 1, "on_time": 0}  # role -> decimal places the old site published
ROLES = ("median_wait", "volume", "long_wait", "on_time")
OLD_REASONS = {  # old suppression code -> the new dist's reason
    "X01": "too_few_patients",
    "X39": "no_patients_reported",
    "X40": "not_published_by_aihw",
}
BENCHMARK_SCOPES = ("national", "states")
EXAMPLES_IN_SUMMARY = 5
REPORT_EXAMPLES = 20
EPSILON = 1e-6
EARTH_RADIUS_M = 6_371_008.8
NEIGHBOURS = 8


@dataclass(frozen=True)
class Fig:
    # state is published, suppressed or absent; detail is the new-style suppression reason.
    state: str
    value: float | None = None
    detail: str | None = None


@dataclass(frozen=True)
class Mesh:
    radius_km: int
    neighbours: tuple[tuple[str, int], ...]


@dataclass
class Side:
    hospitals: dict[str, Doc] = field(default_factory=dict)
    categories: dict[str, tuple[str, str]] = field(default_factory=dict)
    figures: dict[Key, Fig] = field(default_factory=dict)
    ranks: dict[tuple[str, str], dict[str, tuple[int, float]]] = field(default_factory=dict)
    rank_period: dict[tuple[str, str], str] = field(default_factory=dict)
    meshes: dict[tuple[str, str], Mesh] = field(default_factory=dict)
    suburbs: dict[str, tuple[str, str, float, float]] = field(default_factory=dict)
    releases: set[str] = field(default_factory=set)
    # (category, scope, role) -> figure; scope is national or a state code.
    benchmarks: dict[tuple[str, str, str], Fig] = field(default_factory=dict)


def read(path: Path) -> Doc:
    return json.loads(path.read_text(encoding="utf-8"))


def period_of(text: str) -> str:
    return text.replace("-", "\u2013")  # the new dist spells periods with an en dash


def to_percent(role: str, value: float) -> float:
    return round(value * 100, 6) if role in PERCENT_ROLES else value


# ---------------------------------------------------------------- old shapes


def old_fig(raw: Doc) -> Fig | None:
    state = raw.get("state")
    if state == "published":
        return Fig("published", float(raw["value"]))
    if state == "not_published":
        code = raw.get("suppression_code")
        return Fig("suppressed", None, OLD_REASONS.get(code, code))
    return None


def old_entry_figures(
    code: str, cat: str, entry: Doc, out: dict[Key, Fig], releases: set[str]
) -> None:
    for role in ROLES:
        raw = entry.get(role)
        fig = old_fig(raw) if isinstance(raw, dict) else None
        if fig is None:
            continue
        releases.add(str(raw["release_date"]))
        out[code, cat, period_of(str(raw["reference_period"])), role] = fig


def load_old(base: Path) -> Side:
    side = Side()
    index = read(base / "hospitals" / "index.json")
    cols = index["columns"]
    for row in index["hospitals"]:
        rec = dict(zip(cols, row, strict=True))
        side.hospitals[rec["code"]] = {
            "name": rec["name"],
            "slug": rec["slug"],
            "state": str(rec["state"]).upper(),
            "lat": rec["lat"],
            "lon": rec["lon"],
        }
    cat_of: dict[str, str] = {}
    for proc in read(base / "procedures" / "index.json")["procedures"]:
        cat_of[proc["id"]] = proc["category_code"]
        side.categories[proc["category_code"]] = ("procedure", proc["name"])
    for urg in read(base / "urgency.json")["categories"]:
        cat_of["urgency:" + urg["id"]] = "urgency:" + urg["id"]
        side.categories["urgency:" + urg["id"]] = ("urgency", urg["name"])
    for code, rec in side.hospitals.items():
        load_old_hospital(base / "hospitals" / f"{rec['slug']}.json", code, cat_of, side)
    load_old_ranks(base, cat_of, side)
    load_old_benchmarks(base, cat_of, side)
    load_old_suburbs(base, side)
    return side


def load_old_hospital(path: Path, code: str, cat_of: Mapping[str, str], side: Side) -> None:
    page = read(path)
    for kind, key in (("procedure", "procedures"), ("urgency", "urgency")):
        for item in page.get(key, []):
            cat = cat_of[item["id"] if kind == "procedure" else "urgency:" + item["id"]]
            for entry in item.get("trend", []):
                old_entry_figures(code, cat, entry, side.figures, side.releases)
            old_entry_figures(code, cat, item["current"], side.figures, side.releases)
            near = item.get("nearby")
            if near is not None:
                side.meshes[code, cat] = Mesh(
                    near["radius_km"],
                    tuple((n["code"], n["distance_km"]) for n in near["hospitals"]),
                )


def add_old_ranks(rows: Iterable[Doc], cat: str, side: Side) -> None:
    for role in ROLES:
        group = side.ranks.setdefault((cat, role), {})
        for row in rows:
            fig = row.get(role)
            if not isinstance(fig, dict) or fig.get("rank") is None or fig.get("value") is None:
                continue
            group[row["code"]] = (int(fig["rank"]), float(fig["value"]))
            side.rank_period[cat, role] = period_of(str(fig["reference_period"]))


def load_old_ranks(base: Path, cat_of: Mapping[str, str], side: Side) -> None:
    for proc_id, cat in sorted(cat_of.items()):
        if proc_id.startswith("urgency:"):
            continue
        page = read(base / "procedures" / f"{proc_id}.json")
        add_old_ranks(page["hospitals"], cat, side)
    for category in read(base / "urgency.json")["categories"]:
        add_old_ranks(category["hospitals"], "urgency:" + category["id"], side)


def load_old_benchmarks(base: Path, cat_of: Mapping[str, str], side: Side) -> None:
    for proc_id, cat in sorted(cat_of.items()):
        if proc_id.startswith("urgency:"):
            continue
        bench = read(base / "procedures" / f"{proc_id}.json").get("benchmarks") or {}
        scopes = [("national", bench.get("national"))]
        scopes += [(str(row.get("reporting_unit_code")), row) for row in bench.get("states", [])]
        for scope, row in scopes:
            for role in ROLES:
                raw = row.get(role) if isinstance(row, dict) else None
                fig = old_fig(raw) if isinstance(raw, dict) else None
                if fig is not None and raw is not None:
                    side.benchmarks[cat, scope, role] = fig
                    side.releases.add(str(raw["release_date"]))


def load_old_suburbs(base: Path, side: Side) -> None:
    doc = read(base / "localities.json")
    for sal, name, state, lat, lon in doc["localities"]:
        side.suburbs[str(sal)] = (name, state, lat, lon)


# ---------------------------------------------------------------- new shapes


def new_fig(raw: Doc, role: str) -> Fig:
    if raw["state"] == "published":
        return Fig("published", to_percent(role, float(raw["value"])))
    if raw["state"] == "not_published":
        return Fig("suppressed", None, raw.get("reason"))
    return Fig("absent")


def trend_fig(role: str, point: list[Any]) -> Fig | None:
    if point[1] is not None:
        return Fig("published", to_percent(role, float(point[1])))
    state, _, reason = str(point[3] if len(point) > 3 else "").partition(":")  # noqa: PLR2004
    return Fig("suppressed", None, reason or None) if state == "not_published" else None


def load_new(base: Path) -> Side:
    side = Side()
    register = read(base / "hospitals.json")["hospitals"]
    slug_of: dict[str, str] = {}
    for rec in register:
        slug_of[rec["code"]] = rec["slug"]
        side.hospitals[rec["code"]] = {
            "name": rec["name"],
            "slug": rec["slug"],
            "state": str(rec["state"]).upper(),
            "lat": rec["latitude"],
            "lon": rec["longitude"],
        }
    kinds: dict[str, tuple[str, str]] = {}
    for item in read(base / "surgeries.json")["surgeries"]:
        key = category_key(item["kind"], item["code"], item["slug"])
        side.categories[key] = (item["kind"], item["name"])
        kinds[item["slug"]] = (item["kind"], key)
    for code, slug in slug_of.items():
        load_new_hospital(base, code, slug, kinds, side)
    load_new_ranks(base, side)
    load_new_suburbs(base, side)
    return side


def category_key(kind: str, code: str, slug: str) -> str:
    # The old site named urgency categories by id; match them through the slug.
    return "urgency:" + slug.removesuffix("-elective-surgery") if kind == "urgency" else code


def load_new_hospital(
    base: Path, code: str, slug: str, kinds: Mapping[str, tuple[str, str]], side: Side
) -> None:
    page = read(base / "hospitals" / f"{slug}.json")
    near = page.get("nearby")
    if near is not None:
        side.meshes[code, ""] = Mesh(
            near["radius_km"], tuple((n["code"], n["distance_km"]) for n in near["hospitals"])
        )
    trend = base / "trends" / f"{slug}.json"
    # The dist writes no trend file for a hospital with a single period.
    series = read(trend)["series"] if trend.exists() else []
    for one in series:
        cat = kinds[one["slug"]][1]
        for period, point in zip(one["periods"], one["points"], strict=True):
            fig = trend_fig(one["role"], point)
            if fig is not None:
                side.figures[code, cat, period, one["role"]] = fig
    for surgery in page["surgeries"]:
        cat = kinds[surgery["slug"]][1]
        for role, measure in surgery["measures"].items():
            raw = measure["figure"]
            side.releases.add(str(raw["release"]))
            if raw["state"] != "not_reported":
                side.figures[code, cat, raw["period"], role] = new_fig(raw, role)


def load_new_ranks(base: Path, side: Side) -> None:
    for kind in ("procedure", "specialty", "urgency"):
        for path in sorted((base / "surgeries" / kind).glob("*.json")):
            page = read(path)
            cat = category_key(page["kind"], page["code"], page["slug"])
            for hospital in page["hospitals"]:
                for role, measure in hospital["measures"].items():
                    rank = measure["rank"]
                    fig = measure["figure"]
                    group = side.ranks.setdefault((cat, role), {})
                    side.rank_period[cat, role] = fig["period"]
                    if rank["status"] == "ranked":
                        group[hospital["code"]] = (
                            int(rank["position"]),
                            to_percent(role, float(fig["value"])),
                        )


def load_new_suburbs(base: Path, side: Side) -> None:
    for sal, name, state, lat, lon in read(base / "suburbs.json")["suburbs"]:
        side.suburbs[str(sal)] = (name, state, lat, lon)


# ---------------------------------------------------------------- comparison


def compare_fig(role: str, old: Fig, new: Fig) -> str:
    if old.state == "published" and new.state == "published":
        if old.value is None or new.value is None:
            return "differs"
        gap = abs(old.value - new.value)
        if gap <= EPSILON:
            return "equal"
        places = PERCENT_ROLES.get(role)
        if places is not None and gap <= 0.5 * 10 ** (-places) + EPSILON:
            return "rounding"
        return "differs"
    if old.state == "published" or new.state == "published":
        return "published_vs_suppressed"
    return "equal" if old.detail == new.detail else "reason_differs"


def explain(cls: str, key: Key, old_newest: Mapping[str, str]) -> tuple[bool, str]:
    if cls in {"differs", "rounding", "published_vs_suppressed"}:
        return True, "revision in a period both releases carry"
    if cls == "reason_differs":
        return False, "both suppressed, for different reasons"
    if cls == "only_new":
        if key[2] > old_newest.get(key[1], ""):
            return True, "period the older release did not have"
        return False, "new cell inside a period the older release carried"
    return False, "figure in the older release and absent from the newer one"


def direction(old: Fig, new: Fig) -> str:
    return f"{old.state} -> {new.state}"


def figure_row(key: Key, old: Fig | None, new: Fig | None, cls: str) -> Doc:
    return {
        "class": cls,
        "hospital": key[0],
        "category": key[1],
        "period": key[2],
        "role": key[3],
        "old": None if old is None else {"state": old.state, "value": old.value},
        "new": None if new is None else {"state": new.state, "value": new.value},
    }


def compare_hospitals(old: Side, new: Side) -> Doc:
    added = sorted(set(new.hospitals) - set(old.hospitals))
    removed = sorted(set(old.hospitals) - set(new.hospitals))
    renamed: list[Doc] = []
    changed: list[Doc] = []
    for code in sorted(set(old.hospitals) & set(new.hospitals)):
        a, b = old.hospitals[code], new.hospitals[code]
        if a["name"] != b["name"]:
            renamed.append({"code": code, "old": a["name"], "new": b["name"]})
        changed.extend(
            {"code": code, "field": fld, "old": a[fld], "new": b[fld]}
            for fld in ("slug", "state", "lat", "lon")
            if a[fld] != b[fld]
        )
    return {
        "old_count": len(old.hospitals),
        "new_count": len(new.hospitals),
        "added": [{"code": c, "name": new.hospitals[c]["name"]} for c in added],
        "removed": [{"code": c, "name": old.hospitals[c]["name"]} for c in removed],
        "renamed": renamed,
        "other_changes": changed,
    }


def old_newest_period(old: Side) -> dict[str, str]:
    newest: dict[str, str] = {}
    for _, cat, period, _ in old.figures:
        newest[cat] = max(newest.get(cat, ""), period)
    return newest


def compare_figures(old: Side, new: Side) -> tuple[Doc, list[Doc]]:
    common = set(old.hospitals) & set(new.hospitals)
    newest = old_newest_period(old)
    rows: list[Doc] = []
    classes: Counter[str] = Counter()
    explained: Counter[str] = Counter()
    by_role: Counter[tuple[str, str]] = Counter()
    by_period: Counter[tuple[str, str]] = Counter()
    transitions: Counter[str] = Counter()
    reasons: Counter[str] = Counter()
    compared = 0
    skipped: Counter[str] = Counter()
    keys = sorted(set(old.figures) | set(new.figures))
    for key in keys:
        if key[0] not in common:
            skipped["old_only_hospital" if key[0] in old.hospitals else "new_only_hospital"] += 1
            continue
        if key[1] not in old.categories:
            classes["new_category"] += 1
            explained["explained"] += 1
            by_role["new_category", key[3]] += 1
            continue
        a, b = old.figures.get(key), new.figures.get(key)
        if a is not None and b is not None:
            cls = compare_fig(key[3], a, b)
            transitions[direction(a, b)] += 1
            if a.state == "suppressed" and b.state == "suppressed":
                reasons[f"{a.detail} -> {b.detail}"] += 1
        else:
            cls = "only_old" if b is None else "only_new"
        compared += 1
        classes[cls] += 1
        if cls == "equal":
            continue
        is_explained, why = explain(cls, key, newest)
        explained["explained" if is_explained else "unexplained"] += 1
        by_role[cls, key[3]] += 1
        by_period[cls, key[2]] += 1
        row = figure_row(key, a, b, cls)
        row.update({"explained": is_explained, "why": why})
        rows.append(row)
    summary = {
        "compared": compared,
        "equal": classes["equal"],
        "by_class": {c: classes[c] for c in sorted(classes)},
        "explained": {s: explained[s] for s in sorted(explained)},
        "by_class_and_role": nested(by_role),
        "by_class_and_period": nested(by_period),
        "skipped_figures_in_added_or_removed_hospitals": dict(sorted(skipped.items())),
        "suppression_transitions": dict(sorted(transitions.items())),
        "suppression_reason_pairs": dict(sorted(reasons.items())),
    }
    return summary, rows


def nested(counter: Mapping[tuple[str, str], int]) -> Doc:
    out: Doc = {}
    for (first, second), n in sorted(counter.items()):
        out.setdefault(first, {})[second] = n
    return out


def newest_common_period(old: Side, new: Side) -> str:
    shared = {k[2] for k in old.figures} & {k[2] for k in new.figures}
    return max(shared, default="")


def compare_ranks(old: Side, new: Side) -> Doc:
    period = newest_common_period(old, new)
    groups = sorted(set(old.ranks) & set(new.ranks))
    classes: Counter[str] = Counter()
    examples: list[Doc] = []
    for group in groups:
        a, b = old.ranks[group], new.ranks[group]
        if not a and not b:
            continue
        if old.rank_period.get(group) != period or new.rank_period.get(group) != period:
            classes["group_not_in_newest_common_period"] += 1
            continue
        moved = {v[1] for v in a.values()} != {v[1] for v in b.values()} or set(a) != set(b)
        for code in sorted(set(a) & set(b)):
            if a[code][0] == b[code][0]:
                classes["equal"] += 1
                continue
            cls = "differs_group_revised" if moved else "differs_group_unchanged"
            classes[cls] += 1
            examples.append(
                {
                    "class": cls,
                    "category": group[0],
                    "role": group[1],
                    "hospital": code,
                    "old": a[code][0],
                    "new": b[code][0],
                    "explained": moved,
                }
            )
        for code in sorted(set(a) ^ set(b)):
            classes["ranked_on_one_side_only"] += 1
            examples.append(
                {
                    "class": "ranked_on_one_side_only",
                    "category": group[0],
                    "role": group[1],
                    "hospital": code,
                    "old": a.get(code, (None,))[0],
                    "new": b.get(code, (None,))[0],
                    "explained": moved,
                }
            )
    return {
        "period": period,
        "by_class": {c: classes[c] for c in sorted(classes)},
        "differences": examples,
    }


def mesh_class(old: Mesh, new: Mesh) -> str:
    if old.neighbours == new.neighbours:
        return "identical"
    reach = max((d for _, d in new.neighbours), default=0)
    if len(new.neighbours) < NEIGHBOURS:
        reach = math.inf
    listed = dict(new.neighbours)
    for code, dist in old.neighbours:
        # A neighbour exactly at the farthest listed distance may lose the tie-break.
        if dist < reach and listed.get(code) != dist:
            return "inconsistent"
    return "consistent_with_procedure_filter"


def compare_benchmarks(old: Side, new: Side) -> Doc:
    states = Counter(f.state for f in old.benchmarks.values())
    roles = Counter(k[2] for k in old.benchmarks)
    return {
        "old_figures": len(old.benchmarks),
        "old_categories": len({k[0] for k in old.benchmarks}),
        "old_national_figures": sum(1 for k in old.benchmarks if k[1] == "national"),
        "old_state_figures": sum(1 for k in old.benchmarks if k[1] != "national"),
        "old_published": states["published"],
        "old_suppressed": states["suppressed"],
        "old_by_role": dict(sorted(roles.items())),
        "new_figures": len(new.benchmarks),
        "status": "the new dist has no benchmark counterpart yet",
    }


def compare_nearby(old: Side, new: Side) -> Doc:
    classes: Counter[str] = Counter()
    bad: list[Doc] = []
    old_sizes: Counter[int] = Counter()
    old_radii: Counter[int] = Counter()
    for (code, cat), mesh in sorted(old.meshes.items()):
        old_sizes[len(mesh.neighbours)] += 1
        old_radii[mesh.radius_km] += 1
        target = new.meshes.get((code, ""))
        if target is None:
            classes["no_new_mesh"] += 1
            continue
        cls = mesh_class(mesh, target)
        classes[cls] += 1
        if (
            cls != "identical"
            and len(bad) < REPORT_EXAMPLES
            and cls != "consistent_with_procedure_filter"
        ):
            bad.append({"hospital": code, "category": cat, "class": cls})
    return {
        "old_meshes": len(old.meshes),
        "old_minimum_neighbours": 4,
        "by_class": {c: classes[c] for c in sorted(classes)},
        "old_neighbour_counts": {str(k): v for k, v in sorted(old_sizes.items())},
        "old_radius_km": {str(k): v for k, v in sorted(old_radii.items())},
        "new_meshes": len([k for k in new.meshes if k[1] == ""]),
        "new_neighbour_counts": count_sizes(new),
        "new_radius_km": count_radii(new),
        "examples": bad,
    }


def count_sizes(new: Side) -> Doc:
    sizes = Counter(len(m.neighbours) for m in new.meshes.values())
    return {str(k): v for k, v in sorted(sizes.items())}


def count_radii(new: Side) -> Doc:
    radii = Counter(m.radius_km for m in new.meshes.values())
    return {str(k): v for k, v in sorted(radii.items())}


def metres(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    half = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(min(1.0, half)))


def percentile(sorted_values: list[float], fraction: float) -> float:
    return sorted_values[min(len(sorted_values) - 1, int(fraction * len(sorted_values)))]


def compare_suburbs(old: Side, new: Side) -> Doc:
    shared = sorted(set(old.suburbs) & set(new.suburbs))
    moves = sorted(metres(old.suburbs[c][2:], new.suburbs[c][2:]) for c in shared)
    renamed = [c for c in shared if old.suburbs[c][0] != new.suburbs[c][0]]
    restated = [c for c in shared if old.suburbs[c][1] != new.suburbs[c][1]]
    spread: Doc = {}
    if moves:
        spread = {
            "median_m": round(statistics.median(moves), 1),
            "p95_m": round(percentile(moves, 0.95), 1),
            "max_m": round(moves[-1], 1),
            "within_1km": sum(1 for m in moves if m <= 1000),  # noqa: PLR2004
            "over_5km": sum(1 for m in moves if m > 5000),  # noqa: PLR2004
        }
    return {
        "old_count": len(old.suburbs),
        "new_count": len(new.suburbs),
        "added": sorted(set(new.suburbs) - set(old.suburbs))[:REPORT_EXAMPLES],
        "added_count": len(set(new.suburbs) - set(old.suburbs)),
        "removed": sorted(set(old.suburbs) - set(new.suburbs))[:REPORT_EXAMPLES],
        "removed_count": len(set(old.suburbs) - set(new.suburbs)),
        "renamed_count": len(renamed),
        "renamed_examples": [
            {"code": c, "old": old.suburbs[c][0], "new": new.suburbs[c][0]}
            for c in renamed[:REPORT_EXAMPLES]
        ],
        "state_changed_count": len(restated),
        "centre_shift": spread,
    }


def compare(new: Side, old: Side) -> Doc:
    figures, rows = compare_figures(old, new)
    rows.sort(key=lambda r: (r["class"], r["hospital"], r["category"], r["period"], r["role"]))
    return {
        "releases": {"old": sorted(old.releases), "new": sorted(new.releases)},
        "hospitals": compare_hospitals(old, new),
        "categories": compare_categories(old, new),
        "figures": figures,
        "ranks": compare_ranks(old, new),
        "benchmarks": compare_benchmarks(old, new),
        "nearby": compare_nearby(old, new),
        "suburbs": compare_suburbs(old, new),
        "differences": rows,
    }


def compare_categories(old: Side, new: Side) -> Doc:
    gone = sorted(set(old.categories) - set(new.categories))
    fresh = sorted(set(new.categories) - set(old.categories))
    return {
        "only_old": gone,
        "only_new": [{"code": c, "kind": new.categories[c][0]} for c in fresh],
    }


# ---------------------------------------------------------------- output


def top_examples(report: Doc) -> dict[str, list[Doc]]:
    out: dict[str, list[Doc]] = {}
    for row in report["differences"]:
        label = f"{row['class']} ({'explained' if row['explained'] else 'unexplained'})"
        bucket = out.setdefault(label, [])
        if len(bucket) < EXAMPLES_IN_SUMMARY:
            bucket.append(row)
    return out


def summary_text(report: Doc) -> str:
    fig = report["figures"]
    hosp = report["hospitals"]
    lines = [
        f"Releases: old {report['releases']['old']}, new {report['releases']['new']}",
        (
            f"Hospitals: {hosp['old_count']} old, {hosp['new_count']} new, "
            f"{len(hosp['added'])} added, {len(hosp['removed'])} removed, "
            f"{len(hosp['renamed'])} renamed"
        ),
        f"Figures compared: {fig['compared']}, equal: {fig['equal']}",
    ]
    lines += [f"  {cls}: {n}" for cls, n in fig["by_class"].items() if cls != "equal"]
    lines.append(f"  explained/unexplained: {fig['explained']}")
    for label, rows in sorted(top_examples(report).items()):
        lines.append(f"Examples, {label}:")
        lines += [
            f"  {r['hospital']} {r['category']} {r['period']} {r['role']}: {r['old']} -> {r['new']}"
            for r in rows
        ]
    ranks = report["ranks"]
    lines.append(f"Ranks in {ranks['period']}: {ranks['by_class']}")
    bench = report["benchmarks"]
    lines.append(
        f"Benchmarks: {bench['old_figures']} old figures, {bench['new_figures']} new "
        f"({bench['status']})"
    )
    lines.append(f"Nearby: {report['nearby']['by_class']}")
    sub = report["suburbs"]
    lines.append(f"Suburbs: {sub['old_count']} old, {sub['new_count']} new")
    lines.append(f"Suburb centre shift: {sub['centre_shift']}")
    return "\n".join(lines) + "\n"


def render(report: Doc) -> str:
    return json.dumps(report, sort_keys=True, indent=1, ensure_ascii=False) + "\n"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("new_dist", type=Path, help="the new pipeline's dist directory")
    parser.add_argument("baseline", type=Path, help="the previous site's built data directory")
    parser.add_argument("-o", "--output", type=Path, help="where to write the JSON report")
    args = parser.parse_args(argv)
    report = compare(load_new(args.new_dist), load_old(args.baseline))
    if args.output is not None:
        args.output.write_text(render(report), encoding="utf-8")
    sys.stdout.write(summary_text(report))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
