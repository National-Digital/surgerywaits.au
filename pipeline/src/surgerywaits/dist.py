import copy
import hashlib
import json
import re
import shutil
import tempfile
import unicodedata
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from surgerywaits.benchmarks import SCOPES, Benchmarks, derive_benchmarks
from surgerywaits.catalogue import Catalogue, Role
from surgerywaits.contract import validate
from surgerywaits.derive import Derived, DerivedFigure, DerivedObservation, RankStatus, TrendPoint
from surgerywaits.gates import URGENT_SLUG, check_docs, check_freshness
from surgerywaits.hospitals import STATES, Hospital, Register
from surgerywaits.manifest import Entry, as_credit
from surgerywaits.queensland import FacilityQuarter, Overlay
from surgerywaits.rules import rules_doc
from surgerywaits.suburbs import Suburbs
from surgerywaits.suppression import Figure, FigureState, SuppressedTable
from surgerywaits.waiting_times import NATIONAL_SCOPE, Table

Doc = dict[str, Any]
SUMS = "SHA256SUMS"
TABLE_SOURCES: Mapping[Table, str] = {
    Table.URGENCY: "au-elective-surgery-waiting-times",
    Table.PROCEDURE: "au-elective-surgery-waiting-times-by-procedure",
    Table.SPECIALTY: "au-elective-surgery-waiting-times-by-specialty",
}
TABLE_TYPES: Mapping[Table, str] = {
    Table.URGENCY: "ES_URGENCY",
    Table.PROCEDURE: "ES_IP",
    Table.SPECIALTY: "ES_SS",
}
QLD_SOURCES = ("qld-elective-surgery-by-category", "qld-elective-surgery-by-specialty")
REGISTER_SOURCES = (
    "au-myhospitals-reporting-units",
    "au-myhospitals-reporting-unit-mappings",
    "au-hospitals-myhospitals",
)
CATALOGUE_SOURCE = "au-myhospitals-reported-measures"
SUBURB_SOURCE = "abs-suburbs-localities-2021"
STATE_CODES = {**{v: k for k, v in STATES.items()}, "Other Territories": "OT"}
ROLE_ORDER = tuple(r.value for r in Role)
UNITS = {"days": "days", "surgeries": "surgeries", "percent": "percent"}
DIRECTIONS = {True: "lower_is_better", False: "higher_is_better", None: "not_ranked"}
ROLE_UNITS = {
    Role.MEDIAN_WAIT: ("days", "lower_is_better"),
    Role.VOLUME: ("surgeries", "not_ranked"),
    Role.LONG_WAIT: ("percent", "lower_is_better"),
    Role.ON_TIME: ("percent", "higher_is_better"),
}
NON_SLUG = re.compile(r"[^a-z0-9]+")
APOSTROPHES = re.compile("['\\u2019]")
TRAILING_QUALIFIER = re.compile(r"\s*\([^)]*\)\s*$")
# A single period is already on the hospital page, so it is not a trend.
MIN_POINTS = 2
READ_SOURCES = (
    *REGISTER_SOURCES,
    CATALOGUE_SOURCE,
    *TABLE_SOURCES.values(),
    *QLD_SOURCES,
    SUBURB_SOURCE,
)
SCOPE_ORDER = {"urgency": 0, "procedure": 1, "specialty": 2}


class DistError(Exception):
    pass


@dataclass(frozen=True)
class Inputs:
    entries: tuple[Entry, ...]
    register: Register
    catalogue: Catalogue
    tables: Mapping[Table, SuppressedTable]
    derived: Derived
    suburbs: Suburbs
    overlay: Overlay


def slugify(name: str) -> str:
    folded = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return NON_SLUG.sub("-", APOSTROPHES.sub("", folded.lower())).strip("-")


def _hospital_slugs(hospitals: list[Hospital]) -> dict[str, str]:
    """A slug from each name, widened by state and then code only where names collide."""
    base = {h.code: slugify(h.name) for h in hospitals}
    count: dict[str, int] = defaultdict(int)
    for s in base.values():
        count[s] += 1
    slugs = {
        c: (s if count[s] == 1 else f"{s}-{slugify(_state(hospitals, c))}") for c, s in base.items()
    }
    again: dict[str, int] = defaultdict(int)
    for s in slugs.values():
        again[s] += 1
    slugs = {c: (s if again[s] == 1 else f"{s}-{c.lower()}") for c, s in slugs.items()}
    if len(set(slugs.values())) != len(slugs) or "" in slugs.values():
        msg = "hospital slugs are not unique"
        raise DistError(msg)
    return slugs


def network_slugs(hospitals: list[Hospital]) -> dict[str, str]:
    """A slug for each network the hospitals belong to, widened only where names collide."""
    names = {h.network_code: h.network_name for h in hospitals if h.network_code and h.network_name}
    by_base: dict[str, list[str]] = defaultdict(list)
    for code in sorted(names):
        by_base[slugify(network_heading(names[code])) or slugify(names[code])].append(code)
    slugs: dict[str, str] = {}
    for base, codes in sorted(by_base.items()):
        if len(codes) == 1:
            slugs[codes[0]] = base
            continue
        by_full: dict[str, list[str]] = defaultdict(list)
        for code in codes:
            by_full[slugify(names[code])].append(code)
        for full, same in by_full.items():
            for code in same:
                slugs[code] = full if len(same) == 1 else f"{full}-{code.lower()}"
    if len(set(slugs.values())) != len(slugs) or "" in slugs.values():
        msg = "network slugs are not unique"
        raise DistError(msg)
    return slugs


def network_heading(name: str) -> str:
    return TRAILING_QUALIFIER.sub("", name)


def _state(hospitals: list[Hospital], code: str) -> str:
    return next(h.state for h in hospitals if h.code == code)


def _releases(entries: tuple[Entry, ...]) -> dict[str, str]:
    by_slug = {e.slug: e for e in entries}
    found: dict[str, str] = {}
    for slug in (*TABLE_SOURCES.values(), *QLD_SOURCES):
        entry = by_slug.get(slug)
        if entry is None:
            msg = f"the manifest has no entry for {slug}"
            raise DistError(msg)
        if entry.as_at is not None:
            found[slug] = entry.as_at
    for slug in TABLE_SOURCES.values():
        if slug not in found:
            msg = f"{slug} has no release date in the manifest"
            raise DistError(msg)
    return found


def _figure(f: Figure, period: str, release: str) -> Doc:
    state = f.state.value.replace(" ", "_")
    if f.state is FigureState.PUBLISHED:
        return {"state": state, "value": f.value, "period": period, "release": release}
    assert f.reason is not None  # noqa: S101
    return {"state": state, "reason": f.reason.value, "period": period, "release": release}


def _measure(d: DerivedFigure, period: str, release: str) -> Doc:
    if d.status is RankStatus.RANKED:
        rank: Doc = {"status": "ranked", "position": d.rank, "of": d.of}
    else:
        rank = {"status": "unranked", "why": d.status.value.replace(" ", "_")}
    return {"figure": _figure(d.figure, period, release), "rank": rank}


def _measures(o: DerivedObservation, release: str) -> Doc:
    return {f.role.value: _measure(f, o.period, release) for f in o.figures}


def _credits(entries: tuple[Entry, ...], used: set[str]) -> Doc:
    missing = sorted(used - {e.slug for e in entries})
    if missing:
        msg = f"the manifest has no entry for {', '.join(missing)}"
        raise DistError(msg)
    rows = sorted((e for e in entries if e.slug in used), key=lambda e: e.slug)
    return {"sources": [as_credit(e) for e in rows]}


def _categories(inputs: Inputs) -> dict[tuple[Table, str], tuple[str, str]]:
    """Slug and publisher code for each (table, category name); a name with no code fails."""
    by_type: dict[tuple[str, str], str] = {}
    for c in inputs.catalogue.categories:
        key = (c.type_code, c.name)
        if key in by_type:
            msg = f"two catalogue categories are called {c.name!r}"
            raise DistError(msg)
        by_type[key] = c.code
    found: dict[tuple[Table, str], tuple[str, str]] = {}
    for table, suppressed in inputs.tables.items():
        for name in sorted({o.observation.category for o in suppressed.observations}):
            code = by_type.get((TABLE_TYPES[table], name))
            if code is None:
                msg = f"{table.value}: {name!r} is not in the catalogue"
                raise DistError(msg)
            found[table, name] = (slugify(name), code)
        slugs = [found[k][0] for k in found if k[0] is table]
        if len(slugs) != len(set(slugs)) or "" in slugs:
            msg = f"{table.value}: category slugs are not unique"
            raise DistError(msg)
    return found


def _qld_figures(figures: tuple[Figure, ...], period: str, release: str) -> Doc:
    return {f.column: _figure(f, period, release) for f in figures}


def _qld_quarter(r: FacilityQuarter) -> Doc:
    period, release = r.quarter.reference_period, r.release_date.isoformat()
    return {
        "period": period,
        "period_end": r.quarter.end.isoformat(),
        "release": release,
        "total": _qld_figures(r.total, period, release),
        "urgency": [
            {"category": c.category, "figures": _qld_figures(c.figures, period, release)}
            for c in r.categories
        ],
        "specialties": [
            {
                "code": s.specialty.code,
                "slug": s.specialty.slug,
                "name": s.specialty.name,
                "figures": _qld_figures(s.figures, period, release),
            }
            for s in r.specialties
        ],
    }


def _queensland(
    inputs: Inputs, names: Mapping[str, str], slugs: Mapping[str, str]
) -> dict[str, tuple[str, Doc]]:
    overlay = inputs.overlay
    sources = sorted({*QLD_SOURCES, *REGISTER_SOURCES})
    out: dict[str, tuple[str, Doc]] = {}
    by_hospital: dict[str, list[FacilityQuarter]] = defaultdict(list)
    for r in overlay.records:
        by_hospital[r.hospital_code].append(r)
    for code, records in sorted(by_hospital.items()):
        first = records[0]
        out[f"queensland/{code.lower()}.json"] = (
            "queensland",
            {
                "code": code,
                "slug": slugs.get(code),
                "name": names[code],
                "facility": {"code": first.facility_code, "name": first.facility_name},
                "quarters": [_qld_quarter(r) for r in sorted(records, key=lambda r: r.quarter)],
                "sources": sources,
            },
        )
    unmapped = [
        {"facility_code": u.facility_code, "facility_name": u.facility_name, "reason": u.reason}
        for u in overlay.facilities.unmapped
    ]
    others = [
        {"facility_code": u.facility_code, "facility_name": u.facility_name, "reason": u.reason}
        for u in overlay.facilities.not_facilities
    ]
    out["queensland.json"] = (
        "queensland-index",
        {
            "facilities": [
                {
                    "facility_code": m.facility_code,
                    "facility_name": m.facility_name,
                    "hospital_code": m.hospital_code,
                    "matched_by": m.matched_by.value,
                    "slug": slugs.get(m.hospital_code),
                }
                for m in overlay.facilities.matches
            ],
            "unmapped": unmapped,
            "not_facilities": others,
            "specialties": [
                {"code": s.code, "slug": s.slug, "name": s.name} for s in overlay.specialties
            ],
            "quarters": [
                {"period": q.reference_period, "period_end": q.end.isoformat()}
                for q in overlay.quarters
            ],
            "sources": sources,
        },
    )
    return out


@dataclass(frozen=True)
class _Ctx:
    inputs: Inputs
    release_of: Mapping[Table, str]
    newest: Mapping[Table, str]
    scope: Doc
    categories: Mapping[tuple[Table, str], tuple[str, str]]
    latest: Mapping[tuple[str, Table, str], DerivedObservation]
    hospitals: Mapping[str, Hospital]
    slugs: Mapping[str, str]
    network_slugs: Mapping[str, str]
    benchmarks: Mapping[Table, Benchmarks]

    @property
    def sources(self) -> list[str]:
        """Hospital-level files: the register, the category catalogue and every national table."""
        return sorted({*REGISTER_SOURCES, CATALOGUE_SOURCE, *TABLE_SOURCES.values()})

    def slug_of(self, table: Table, category: str) -> str:
        return self.categories[table, category][0]


def build_context(inputs: Inputs) -> _Ctx:
    releases = _releases(inputs.entries)
    register = inputs.register
    latest: dict[tuple[str, Table, str], DerivedObservation] = {}
    for o in inputs.derived.observations:
        key = (o.code, o.table, o.category)
        if key not in latest or latest[key].period < o.period:
            latest[key] = o
    hospitals = {h.code: h for h in register.hospitals}
    newest = dict(inputs.derived.newest_periods)
    benchmarks = {t: derive_benchmarks(s, newest[t]) for t, s in inputs.tables.items()}
    with_data = sorted({k[0] for k in latest})
    unknown = sorted(set(with_data) - set(hospitals))
    if unknown:
        msg = f"figures for hospitals outside the register: {unknown}"
        raise DistError(msg)
    return _Ctx(
        inputs,
        {t: releases[s] for t, s in TABLE_SOURCES.items()},
        dict(inputs.derived.newest_periods),
        {"sector": "public", "private_excluded": sorted(register.excluded_private)},
        _categories(inputs),
        latest,
        hospitals,
        _hospital_slugs([hospitals[c] for c in with_data]),
        network_slugs([h for c in with_data if (h := hospitals[c]).network_status == "mapped"]),
        benchmarks,
    )


def _nearby(ctx: _Ctx, code: str) -> Doc | None:
    mesh = next((m for m in ctx.inputs.derived.mesh.meshes if m.code == code), None)
    if mesh is None:
        return None
    names = {h.code: h.name for h in ctx.inputs.register.hospitals}
    return {
        "radius_km": mesh.radius_km,
        "hospitals": [
            {
                "code": n.code,
                "name": names[n.code],
                "slug": ctx.slugs.get(n.code),
                "distance_km": n.distance_km,
            }
            for n in mesh.neighbours
        ],
    }


def _network(ctx: _Ctx, h: Hospital) -> Doc | None:
    if h.network_status != "mapped" or h.network_code is None:
        return None
    return {
        "code": h.network_code,
        "name": h.network_name,
        "slug": ctx.network_slugs[h.network_code],
    }


def _hospital_docs(ctx: _Ctx) -> dict[str, tuple[str, Doc]]:
    docs: dict[str, tuple[str, Doc]] = {}
    rows: list[Doc] = []
    for code, slug in sorted(ctx.slugs.items()):
        h = ctx.hospitals[code]
        mine = sorted(
            (o for k, o in ctx.latest.items() if k[0] == code),
            key=lambda o: (SCOPE_ORDER[o.table.value], ctx.slug_of(o.table, o.category)),
        )
        network = _network(ctx, h)
        docs[f"hospitals/{slug}.json"] = (
            "hospital",
            {
                "code": code,
                "slug": slug,
                "name": h.name,
                "alternative_names": list(h.alternative_names),
                "state": h.state,
                "closed": h.closed,
                "network": network,
                "location": (
                    {"latitude": h.latitude, "longitude": h.longitude}
                    if h.latitude is not None
                    else None
                ),
                "scope": ctx.scope,
                "surgeries": [
                    {
                        "kind": o.table.value,
                        "slug": ctx.slug_of(o.table, o.category),
                        "name": o.category,
                        "stale": o.period != ctx.newest[o.table],
                        "measures": _measures(o, ctx.release_of[o.table]),
                    }
                    for o in mine
                ],
                "nearby": _nearby(ctx, code),
                "sources": ctx.sources,
            },
        )
        rows.append(
            {
                "code": code,
                "slug": slug,
                "name": h.name,
                "state": h.state,
                "closed": h.closed,
                "network": network,
                "latitude": h.latitude,
                "longitude": h.longitude,
                "surgeries": len(mine),
                "latest_period": max(o.period for o in mine),
            }
        )
    docs["hospitals.json"] = (
        "hospital-index",
        {"scope": ctx.scope, "hospitals": rows, "sources": ctx.sources},
    )
    return docs


def _urgent_lookup(ctx: _Ctx) -> dict[str, DerivedObservation]:
    """The latest urgent-surgery observation of each hospital; fails if the category is gone."""
    if not any(
        table is Table.URGENCY and slug == URGENT_SLUG
        for (table, _), (slug, _) in ctx.categories.items()
    ):
        msg = f"no urgency category has the slug {URGENT_SLUG!r}"
        raise DistError(msg)
    return {
        code: o
        for (code, table, category), o in ctx.latest.items()
        if table is Table.URGENCY and ctx.slug_of(table, category) == URGENT_SLUG
    }


def urgent_on_time(ctx: _Ctx, o: DerivedObservation | None) -> Doc:
    """The on-time figure for urgent surgery, with the period and release it comes from."""
    release = ctx.release_of[Table.URGENCY]
    if o is None:
        return {"status": "missing", "figure": None, "period": None, "release": None}
    if o.period != ctx.newest[Table.URGENCY]:
        return {"status": "stale", "figure": None, "period": o.period, "release": release}
    found = next((f for f in o.figures if f.role is Role.ON_TIME), None)
    if found is None:
        return {"status": "missing", "figure": None, "period": None, "release": None}
    figure = _figure(found.figure, o.period, release)
    return {"status": figure["state"], "figure": figure, "period": o.period, "release": release}


KIND_FIELDS = {
    "urgency": Table.URGENCY,
    "procedures": Table.PROCEDURE,
    "specialties": Table.SPECIALTY,
}


def network_docs(ctx: _Ctx) -> dict[str, tuple[str, Doc]]:
    """One file for each network with a hospital that has a page, and an index of them."""
    members: dict[str, list[Hospital]] = defaultdict(list)
    for code in sorted(ctx.slugs):
        h = ctx.hospitals[code]
        if h.network_status == "mapped" and h.network_code is not None:
            members[h.network_code].append(h)
    reported: dict[str, dict[Table, int]] = defaultdict(lambda: defaultdict(int))
    for (code, table, _), o in ctx.latest.items():
        if o.period == ctx.newest[table]:
            reported[code][table] += 1
    urgent = _urgent_lookup(ctx)

    def counts(code: str) -> Doc:
        """Categories reported in the newest period of each table, under that table's stamp."""
        return {
            name: {
                "count": reported[code][t],
                "period": ctx.newest[t],
                "release": ctx.release_of[t],
            }
            for name, t in KIND_FIELDS.items()
        }

    docs: dict[str, tuple[str, Doc]] = {}
    rows: list[Doc] = []
    for code, hospitals in sorted(members.items()):
        name = hospitals[0].network_name or ""
        slug = ctx.network_slugs[code]
        head: Doc = {
            "code": code,
            "slug": slug,
            "name": name,
            "display_name": network_heading(name) or name,
            "states": sorted({h.state for h in hospitals}),
        }
        docs[f"health-services/{slug}.json"] = (
            "health-service",
            {
                **head,
                "scope": ctx.scope,
                "hospitals": [
                    {
                        "code": h.code,
                        "slug": ctx.slugs[h.code],
                        "name": h.name,
                        "state": h.state,
                        "closed": h.closed,
                        "surgeries": counts(h.code),
                        "urgent_on_time": urgent_on_time(ctx, urgent.get(h.code)),
                    }
                    for h in sorted(hospitals, key=lambda h: (h.name, h.code))
                ],
                "sources": ctx.sources,
            },
        )
        rows.append({**head, "hospitals": len(hospitals)})
    docs["health-services.json"] = (
        "health-service-index",
        {"networks": sorted(rows, key=lambda r: r["slug"]), "sources": ctx.sources},
    )
    return docs


def _point(p: TrendPoint) -> list[Any]:
    """[year, value, change], or [year, null, null, "state:reason"] when not published."""
    year = int(p.period[:4])
    if p.figure.state is FigureState.PUBLISHED:
        return [year, p.figure.value, p.change]
    assert p.figure.reason is not None  # noqa: S101
    return [year, None, None, f"{p.figure.state.value.replace(' ', '_')}:{p.figure.reason.value}"]


def _trend_docs(ctx: _Ctx) -> dict[str, tuple[str, Doc]]:
    series: dict[str, list[Doc]] = defaultdict(list)
    for t in ctx.inputs.derived.trends:
        if t.code not in ctx.slugs:
            continue
        if len(t.points) < MIN_POINTS:
            continue
        series[t.code].append(
            {
                "kind": t.table.value,
                "slug": ctx.slug_of(t.table, t.category),
                "role": t.role.value,
                "release": ctx.release_of[t.table],
                "periods": [p.period for p in t.points],
                "points": [_point(p) for p in t.points],
            }
        )
    docs: dict[str, tuple[str, Doc]] = {}
    for code, rows in series.items():
        rows.sort(key=lambda s: (SCOPE_ORDER[s["kind"]], s["slug"], ROLE_ORDER.index(s["role"])))
        slug = ctx.slugs[code]
        docs[f"trends/{slug}.json"] = (
            "trend",
            {"code": code, "slug": slug, "series": rows, "sources": ctx.sources},
        )
    return docs


def _benchmark_measures(figures: tuple[tuple[Role, Figure], ...], period: str, release: str) -> Doc:
    return {role.value: _figure(f, period, release) for role, f in figures}


def _benchmark_doc(ctx: _Ctx, table: Table, name: str) -> Doc:
    found = ctx.benchmarks[table]
    period, release = ctx.newest[table], ctx.release_of[table]

    def measures(scope: str) -> Doc | None:
        figures = found.current.get((name, scope))
        return _benchmark_measures(figures, period, release) if figures else None

    series = [
        {
            "scope": scope,
            "role": role.value,
            "release": release,
            "periods": [p.period for p in points],
            "points": [_point(p) for p in points],
        }
        for scope in SCOPES
        for role in Role
        if len(points := found.series.get((name, scope, role), ())) >= MIN_POINTS
    ]
    return {
        "national": measures(NATIONAL_SCOPE),
        "states": [
            {"state": scope, "measures": m} for scope in SCOPES[1:] if (m := measures(scope))
        ],
        "trends": series,
    }


def _state_docs(
    ctx: _Ctx, surgery_docs: Mapping[str, tuple[str, Doc]]
) -> dict[str, tuple[str, Doc]]:
    """One file for each state: its figure for every category beside the national figure."""
    rows: dict[str, list[Doc]] = defaultdict(list)
    used: dict[str, set[str]] = defaultdict(set)
    for _, (kind, d) in sorted(surgery_docs.items()):
        if kind != "surgery":
            continue
        for entry in d["benchmarks"]["states"]:
            rows[entry["state"]].append(
                {
                    "kind": d["kind"],
                    "slug": d["slug"],
                    "name": d["name"],
                    "period": d["period"],
                    "release": d["release"],
                    "measures": copy.deepcopy(entry["measures"]),
                    "national": copy.deepcopy(d["benchmarks"]["national"]),
                }
            )
            used[entry["state"]].add(TABLE_SOURCES[Table(d["kind"])])
    docs: dict[str, tuple[str, Doc]] = {}
    for code in SCOPES[1:]:
        if code not in rows:
            continue
        ordered = sorted(rows[code], key=lambda r: (SCOPE_ORDER[r["kind"]], r["slug"]))
        docs[f"states/{code.lower()}.json"] = (
            "state",
            {
                "state": code,
                "slug": code.lower(),
                "name": STATES[code],
                "scope": ctx.scope,
                "surgeries": ordered,
                "sources": sorted({*REGISTER_SOURCES, CATALOGUE_SOURCE, *used[code]}),
            },
        )
    return docs


def _median_order(ctx: _Ctx, o: DerivedObservation) -> tuple[int, int, str, str]:
    median = next((f for f in o.figures if f.role is Role.MEDIAN_WAIT), None)
    position = median.rank if median is not None else None
    name = ctx.hospitals[o.code].name
    return (0, position, name, o.code) if position is not None else (1, 0, name, o.code)


def _surgery_docs(ctx: _Ctx) -> dict[str, tuple[str, Doc]]:
    docs: dict[str, tuple[str, Doc]] = {}
    rows: list[Doc] = []
    ordered = sorted(ctx.categories.items(), key=lambda kv: (SCOPE_ORDER[kv[0][0].value], kv[1][0]))
    for (table, name), (slug, code) in ordered:
        current = [
            o
            for o in ctx.inputs.derived.observations
            if o.table is table and o.category == name and o.period == ctx.newest[table]
        ]
        if not current:
            continue
        roles = sorted({f.role for o in current for f in o.figures}, key=_role_key)
        release = ctx.release_of[table]
        docs[f"surgeries/{table.value}/{slug}.json"] = (
            "surgery",
            {
                "kind": table.value,
                "slug": slug,
                "name": name,
                "code": code,
                "period": ctx.newest[table],
                "release": release,
                "units": {
                    r.value: {"unit": ROLE_UNITS[r][0], "direction": ROLE_UNITS[r][1]}
                    for r in roles
                },
                "scope": ctx.scope,
                "hospitals": [
                    {
                        "code": o.code,
                        "slug": ctx.slugs[o.code],
                        "name": ctx.hospitals[o.code].name,
                        "state": ctx.hospitals[o.code].state,
                        "closed": ctx.hospitals[o.code].closed,
                        "measures": _measures(o, release),
                    }
                    for o in sorted(current, key=lambda o: _median_order(ctx, o))
                ],
                "benchmarks": _benchmark_doc(ctx, table, name),
                "sources": sorted({*REGISTER_SOURCES, CATALOGUE_SOURCE, TABLE_SOURCES[table]}),
            },
        )
        rows.append(
            {
                "kind": table.value,
                "slug": slug,
                "name": name,
                "code": code,
                "hospitals": len(current),
                "newest_period": ctx.newest[table],
            }
        )
    docs["surgeries.json"] = ("surgery-index", {"surgeries": rows, "sources": ctx.sources})
    return docs


def _index_doc(ctx: _Ctx, rows: Mapping[str, tuple[str, Doc]]) -> Doc:
    surgeries = rows["surgeries.json"][1]["surgeries"]
    inputs = ctx.inputs
    return {
        "scope": ctx.scope,
        "tables": [
            {
                "kind": t.value,
                "source": TABLE_SOURCES[t],
                "newest_period": ctx.newest[t],
                "release": ctx.release_of[t],
            }
            for t in sorted(ctx.newest, key=lambda t: SCOPE_ORDER[t.value])
        ],
        "counts": {
            "hospitals_in_register": len(inputs.register.hospitals),
            "hospitals_with_figures": len(ctx.slugs),
            "surgeries": {k: sum(1 for r in surgeries if r["kind"] == k) for k in SCOPE_ORDER},
            "suburbs": len(inputs.suburbs.suburbs),
            "queensland_facilities": len(inputs.overlay.facilities.matches),
            "files": len(rows) + 1,
        },
        "hospitals_without_coordinates": sorted(inputs.derived.mesh.without_coordinates),
        "sources": sorted(READ_SOURCES),
    }


def assemble(inputs: Inputs) -> dict[str, tuple[str, Doc]]:
    """Every dist file as (schema name, document), keyed by its path under the output directory."""
    check_freshness(
        inputs.entries,
        {TABLE_SOURCES[t]: p for t, p in inputs.derived.newest_periods},
        TABLE_SOURCES.values(),
        inputs.overlay.records,
    )
    ctx = build_context(inputs)
    names = {h.code: h.name for h in inputs.register.hospitals}
    docs = {**_hospital_docs(ctx), **_trend_docs(ctx), **_surgery_docs(ctx), **network_docs(ctx)}
    docs.update(_state_docs(ctx, docs))
    docs["suburbs.json"] = (
        "suburbs",
        {
            "suburbs": [
                [s.code, s.name, _suburb_state(s.state), s.latitude, s.longitude]
                for s in inputs.suburbs.suburbs
            ],
            "sources": [SUBURB_SOURCE],
        },
    )
    docs.update(_queensland(inputs, names, ctx.slugs))
    docs["credits.json"] = ("credits", _credits(inputs.entries, set(READ_SOURCES)))
    docs["rules.json"] = ("rules", rules_doc())
    docs["index.json"] = ("index", _index_doc(ctx, docs))
    check_docs(inputs.entries, docs)
    return docs


def _role_key(role: Role) -> int:
    return ROLE_ORDER.index(role.value)


def _suburb_state(name: str) -> str:
    if name not in STATE_CODES:
        msg = f"unknown suburb state {name!r}"
        raise DistError(msg)
    return STATE_CODES[name]


def serialise(document: Doc) -> bytes:
    text = json.dumps(
        document, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    )
    return f"{text}\n".encode()


def render(docs: Mapping[str, tuple[str, Doc]]) -> dict[str, bytes]:
    """Validate every document against its schema, then serialise; nothing is written on failure."""
    problems: list[str] = []
    files: dict[str, bytes] = {}
    for path, (schema, document) in sorted(docs.items()):
        try:
            validate(schema, document)
        except Exception as err:  # noqa: BLE001
            problems.append(f"{path}: {err}")
            continue
        files[path] = serialise(document)
    if problems:
        msg = f"{len(problems)} files break their contract: " + "; ".join(problems[:5])
        raise DistError(msg)
    files[SUMS] = "".join(
        f"{hashlib.sha256(files[p]).hexdigest()}  {p}\n" for p in sorted(files)
    ).encode()
    return files


def _verify(directory: Path, files: Mapping[str, bytes]) -> None:
    listed: dict[str, str] = {}
    for line in (directory / SUMS).read_text(encoding="utf-8").splitlines():
        digest, _, path = line.partition("  ")
        listed[path] = digest
    found = {p.relative_to(directory).as_posix() for p in directory.rglob("*") if p.is_file()}
    if found != set(files) or set(listed) != set(files) - {SUMS}:
        msg = "the written files are not the files that were rendered"
        raise DistError(msg)
    for path, digest in listed.items():
        if hashlib.sha256((directory / path).read_bytes()).hexdigest() != digest:
            msg = f"{path} does not match {SUMS}"
            raise DistError(msg)


def write(files: Mapping[str, bytes], out: Path) -> None:
    """Write beside `out`, verify the checksums, then swap in; `out` is never left part-written."""
    if out.exists() and any(out.iterdir()) and not (out / SUMS).is_file():
        msg = f"{out} is not empty and is not a dist directory"
        raise DistError(msg)
    out.parent.mkdir(parents=True, exist_ok=True)
    old = out.with_name(f".{out.name}.old")
    shutil.rmtree(old, ignore_errors=True)
    new = Path(tempfile.mkdtemp(prefix=f".{out.name}.new-", dir=out.parent))
    try:
        for path, data in files.items():
            target = new / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        _verify(new, files)
        new.chmod(0o755)
        had_previous = out.exists()
        if had_previous:
            out.replace(old)
        try:
            new.replace(out)
        except OSError:
            if had_previous:
                old.replace(out)
            raise
    except BaseException:
        shutil.rmtree(new, ignore_errors=True)
        raise
    shutil.rmtree(old, ignore_errors=True)


def build_dist(inputs: Inputs, out: Path) -> dict[str, bytes]:
    files = render(assemble(inputs))
    write(files, out)
    return files
