import importlib.util
import json
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "parity.py"
SPEC = importlib.util.spec_from_file_location("parity", SCRIPT)
assert SPEC is not None
assert SPEC.loader is not None
parity: ModuleType = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(parity)

OLD_RELEASE = "2026-05-28"
NEW_RELEASE = "2026-08-19"
CAT = "ES_I001_Test"
SLUG = "test-surgery"
EXPECTED_SHIFT_M = 90.0
DASH = chr(0x2013)
SUPPRESSED = "not_published:too_few_patients"
OLD = {"X01": "too_few_patients", "X39": "no_patients_reported", "X40": "not_published_by_aihw"}
PERIODS = ("2023-24", "2024-25")


@dataclass
class Spec:
    # (hospital, period) -> value; None is a suppressed cell.
    median: dict[tuple[str, str], float | None]
    # Percent points on the old site; the new dist carries the fraction.
    long_wait: dict[tuple[str, str], float | None]
    names: dict[str, str]
    nearby: dict[str, list[tuple[str, int]]]
    suburbs: list[tuple[str, str, str, float, float]]


def base_spec() -> Spec:
    return Spec(
        median={
            ("H1", "2023-24"): 50.0,
            ("H1", "2024-25"): 60.0,
            ("H2", "2023-24"): 70.0,
            ("H2", "2024-25"): 80.0,
        },
        long_wait={("H1", "2024-25"): 7.0, ("H2", "2024-25"): None},
        names={"H1": "First Hospital", "H2": "Second Hospital"},
        nearby={"H1": [("H2", 10)], "H2": [("H1", 10)]},
        suburbs=[("1", "Alpha", "NSW", -33.0, 151.0), ("2", "Beta", "Vic", -37.0, 145.0)],
    )


def slug_of(code: str) -> str:
    return f"hospital-{code.lower()}"


def put(path: Path, doc: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")


def codes(spec: Spec) -> list[str]:
    return sorted(spec.names)


def old_fig(period: str, value: float | None) -> dict[str, Any]:
    common: dict[str, Any] = {"reference_period": period, "release_date": OLD_RELEASE}
    if value is None:
        return {**common, "state": "not_published", "suppressed": True, "suppression_code": "X01"}
    return {**common, "state": "published", "suppressed": False, "value": value}


def old_entry(spec: Spec, code: str, period: str) -> dict[str, Any]:
    entry: dict[str, Any] = {"reference_period": period}
    if (code, period) in spec.median:
        entry["median_wait"] = old_fig(period, spec.median[code, period])
    if (code, period) in spec.long_wait:
        entry["long_wait"] = old_fig(period, spec.long_wait[code, period])
    return entry


def write_old(base: Path, spec: Spec) -> None:
    put(
        base / "hospitals" / "index.json",
        {
            "columns": ["code", "slug", "name", "state", "lat", "lon"],
            "hospitals": [[c, slug_of(c), spec.names[c], "QLD", -27.0, 153.0] for c in codes(spec)],
        },
    )
    put(
        base / "procedures" / "index.json",
        {"procedures": [{"id": SLUG, "name": "Test surgery", "category_code": CAT}]},
    )
    rows: list[dict[str, Any]] = []
    for code in codes(spec):
        trend = [old_entry(spec, code, p) for p in PERIODS if (code, p) in spec.median]
        current = old_entry(spec, code, PERIODS[-1])
        near = spec.nearby.get(code, [])
        item: dict[str, Any] = {
            "id": SLUG,
            "current": current,
            "trend": trend,
            "nearby": {
                "radius_km": 250,
                "hospitals": [{"code": c, "distance_km": d} for c, d in near],
            },
        }
        put(
            base / "hospitals" / f"{slug_of(code)}.json",
            {"procedures": [item], "urgency": []},
        )
        rows.append({"code": code, **current})
    ranked = sorted(
        (r for r in rows if r["median_wait"]["state"] == "published"),
        key=lambda r: r["median_wait"]["value"],
    )
    for position, row in enumerate(ranked, start=1):
        row["median_wait"] = {**row["median_wait"], "rank": position}
    bench = {"reference_period": PERIODS[-1], "release_date": OLD_RELEASE, "state": "published"}
    put(
        base / "procedures" / f"{SLUG}.json",
        {
            "hospitals": rows,
            "benchmarks": {
                "national": {
                    "median_wait": {**bench, "value": 90.0},
                    "volume": bench | {"value": 5},
                },
                "states": [
                    {
                        "reporting_unit_code": "NSW",
                        "median_wait": {**bench, "value": 95.0},
                        "long_wait": old_fig(PERIODS[-1], None),
                    }
                ],
            },
        },
    )
    put(base / "urgency.json", {"categories": []})
    put(
        base / "localities.json",
        {"localities": [[s, n, st, lat, lon] for s, n, st, lat, lon in spec.suburbs]},
    )


def new_fig(period: str, value: float | None, role: str) -> dict[str, Any]:
    common = {"period": period.replace("-", DASH), "release": NEW_RELEASE}
    if value is None:
        return {**common, "state": "not_published", "reason": "too_few_patients"}
    return {**common, "state": "published", "value": value / 100 if role == "long_wait" else value}


def write_new(base: Path, spec: Spec) -> None:
    put(
        base / "hospitals.json",
        {
            "hospitals": [
                {
                    "code": c,
                    "slug": slug_of(c),
                    "name": spec.names[c],
                    "state": "Qld",
                    "latitude": -27.0,
                    "longitude": 153.0,
                }
                for c in codes(spec)
            ]
        },
    )
    put(
        base / "surgeries.json",
        {"surgeries": [{"kind": "procedure", "code": CAT, "slug": SLUG, "name": "Test surgery"}]},
    )
    page_rows: list[dict[str, Any]] = []
    ranked = sorted(
        (v, c) for (c, p), v in spec.median.items() if p == PERIODS[-1] and v is not None
    )
    positions = {c: i for i, (_, c) in enumerate(ranked, start=1)}
    for code in codes(spec):
        write_new_hospital(base, spec, code)
        measures: dict[str, Any] = {}
        for role, table in (("median_wait", spec.median), ("long_wait", spec.long_wait)):
            if (code, PERIODS[-1]) not in table:
                continue
            fig = new_fig(PERIODS[-1], table[code, PERIODS[-1]], role)
            rank: dict[str, Any] = {"status": "unranked", "why": "not_published"}
            if role == "median_wait" and code in positions:
                rank = {"status": "ranked", "position": positions[code], "of": len(ranked)}
            measures[role] = {"figure": fig, "rank": rank}
        page_rows.append({"code": code, "measures": measures})
    put(
        base / "surgeries" / "procedure" / f"{SLUG}.json",
        {"kind": "procedure", "code": CAT, "slug": SLUG, "hospitals": page_rows},
    )
    put(
        base / "suburbs.json",
        {"suburbs": [[s, n, st, lat, lon] for s, n, st, lat, lon in spec.suburbs]},
    )


def write_new_hospital(base: Path, spec: Spec, code: str) -> None:
    near = spec.nearby.get(code, [])
    measures: dict[str, Any] = {}
    for role, table in (("median_wait", spec.median), ("long_wait", spec.long_wait)):
        if (code, PERIODS[-1]) in table:
            measures[role] = {"figure": new_fig(PERIODS[-1], table[code, PERIODS[-1]], role)}
    put(
        base / "hospitals" / f"{slug_of(code)}.json",
        {
            "nearby": {
                "radius_km": 250,
                "hospitals": [{"code": c, "distance_km": d} for c, d in near],
            },
            "surgeries": [{"kind": "procedure", "slug": SLUG, "measures": measures}],
        },
    )
    points = [
        [int(p[:4]), v, None] if v is not None else [int(p[:4]), None, None, SUPPRESSED]
        for p in PERIODS
        if (v := spec.median.get((code, p), -1.0)) != -1.0
    ]
    periods = [p.replace("-", DASH) for p in PERIODS if (code, p) in spec.median]
    put(
        base / "trends" / f"{slug_of(code)}.json",
        {
            "series": [
                {
                    "kind": "procedure",
                    "slug": SLUG,
                    "role": "median_wait",
                    "periods": periods,
                    "points": points,
                }
            ]
        },
    )


def run(tmp_path: Path, old: Spec, new: Spec) -> dict[str, Any]:
    write_old(tmp_path / "old", old)
    write_new(tmp_path / "new", new)
    report: dict[str, Any] = parity.compare(
        parity.load_new(tmp_path / "new"), parity.load_old(tmp_path / "old")
    )
    return report


def classes(report: dict[str, Any]) -> dict[str, int]:
    return dict(report["figures"]["by_class"])


def test_identical_data_has_no_differences(tmp_path: Path) -> None:
    report = run(tmp_path, base_spec(), base_spec())
    assert report["differences"] == []
    assert classes(report) == {"equal": report["figures"]["compared"]}
    assert report["figures"]["compared"] > 0
    assert report["ranks"]["by_class"] == {"equal": 2}
    assert report["nearby"]["by_class"] == {"identical": 2}
    assert report["suburbs"]["centre_shift"]["max_m"] == 0


def test_a_revised_figure_is_a_difference_explained_by_the_release(tmp_path: Path) -> None:
    new = base_spec()
    new.median[("H1", "2023-24")] = 51.0
    report = run(tmp_path, base_spec(), new)
    (row,) = report["differences"]
    assert (row["class"], row["period"], row["role"]) == (
        "differs",
        "2023-24".replace("-", DASH),
        "median_wait",
    )
    assert row["explained"] is True
    assert report["figures"]["explained"] == {"explained": 1}


def test_a_percent_gap_inside_the_old_rounding_is_its_own_class(tmp_path: Path) -> None:
    new = base_spec()
    new.long_wait[("H1", "2024-25")] = 7.04
    report = run(tmp_path, base_spec(), new)
    assert classes(report)["rounding"] == 1


def test_percent_fractions_are_scaled_before_comparing(tmp_path: Path) -> None:
    report = run(tmp_path, base_spec(), base_spec())
    assert "differs" not in classes(report)


def test_published_against_suppressed_names_the_direction(tmp_path: Path) -> None:
    new = base_spec()
    new.median[("H2", "2024-25")] = None
    report = run(tmp_path, base_spec(), new)
    rows = [r for r in report["differences"] if r["class"] == "published_vs_suppressed"]
    assert {r["period"] for r in rows} == {f"2024{DASH}25"}
    assert report["figures"]["suppression_transitions"]["published -> suppressed"] >= 1


def test_suppressed_on_both_sides_is_equal_and_counted(tmp_path: Path) -> None:
    report = run(tmp_path, base_spec(), base_spec())
    assert report["figures"]["suppression_transitions"]["suppressed -> suppressed"] == 1
    pairs = report["figures"]["suppression_reason_pairs"]
    assert pairs == {"too_few_patients -> too_few_patients": 1}


def test_a_new_period_is_explained_and_a_dropped_figure_is_not(tmp_path: Path) -> None:
    old = base_spec()
    del old.median[("H1", "2023-24")]
    report = run(tmp_path, old, base_spec())
    (row,) = report["differences"]
    assert row["class"] == "only_new"
    assert row["explained"] is False  # the older release carried 2024-25, so 2023-24 is inside it

    new = base_spec()
    del new.median[("H2", "2023-24")]
    report = run(tmp_path / "again", base_spec(), new)
    (row,) = report["differences"]
    assert (row["class"], row["explained"]) == ("only_old", False)


def test_a_period_after_the_old_newest_is_explained() -> None:
    key: Any = parity.Fig
    new_only = (("H1", CAT, f"2025{DASH}26", "median_wait"), key("published", 9.0))
    old = parity.Side(hospitals={"H1": {}}, categories={CAT: ("procedure", "x")})
    old.figures[("H1", CAT, f"2024{DASH}25", "median_wait")] = key("published", 1.0)
    new = parity.Side(hospitals={"H1": {}}, categories={CAT: ("procedure", "x")})
    new.figures.update(dict([new_only]))
    summary, rows = parity.compare_figures(old, new)
    classes_seen = {r["class"]: r["explained"] for r in rows}
    assert classes_seen == {"only_new": True, "only_old": False}
    assert summary["compared"] == len(rows)


def test_a_category_the_old_site_lacked_is_counted_apart() -> None:
    old = parity.Side(hospitals={"H1": {}})
    new = parity.Side(hospitals={"H1": {}})
    new.figures[("H1", "ES_S1", f"2024{DASH}25", "median_wait")] = parity.Fig("published", 1.0)
    summary, rows = parity.compare_figures(old, new)
    assert rows == []
    assert summary["compared"] == 0
    assert summary["by_class"] == {"new_category": 1}


def test_hospitals_added_removed_and_renamed_are_listed(tmp_path: Path) -> None:
    old, new = base_spec(), base_spec()
    new.names["H1"] = "First Hospital Renamed"
    del new.names["H2"]
    new.names["H3"] = "Third Hospital"
    new.nearby = {}
    report = run(tmp_path, old, new)
    hospitals = report["hospitals"]
    assert [h["code"] for h in hospitals["added"]] == ["H3"]
    assert [h["code"] for h in hospitals["removed"]] == ["H2"]
    assert hospitals["renamed"] == [
        {"code": "H1", "old": "First Hospital", "new": "First Hospital Renamed"}
    ]
    assert report["figures"]["skipped_figures_in_added_or_removed_hospitals"]


def test_a_rank_change_with_unchanged_values_is_unexplained() -> None:
    old = parity.Side()
    new = parity.Side()
    group = (CAT, "median_wait")
    for side, pos in ((old, 1), (new, 2)):
        side.ranks[group] = {"H1": (pos, 10.0)}
        side.rank_period[group] = f"2024{DASH}25"
    old.figures[("H1", CAT, f"2024{DASH}25", "median_wait")] = parity.Fig("published", 10.0)
    new.figures[("H1", CAT, f"2024{DASH}25", "median_wait")] = parity.Fig("published", 10.0)
    ranks = parity.compare_ranks(old, new)
    assert ranks["by_class"] == {"differs_group_unchanged": 1}
    assert ranks["differences"][0]["explained"] is False


def test_a_rank_change_after_a_revision_is_explained() -> None:
    old = parity.Side()
    new = parity.Side()
    group = (CAT, "median_wait")
    old.ranks[group] = {"H1": (1, 10.0), "H2": (2, 20.0)}
    new.ranks[group] = {"H1": (2, 25.0), "H2": (1, 20.0)}
    for side in (old, new):
        side.rank_period[group] = f"2024{DASH}25"
        side.figures[("H1", CAT, f"2024{DASH}25", "median_wait")] = parity.Fig("published", 1.0)
    ranks = parity.compare_ranks(old, new)
    assert ranks["by_class"] == {"differs_group_revised": len(old.ranks[group])}
    assert all(d["explained"] for d in ranks["differences"])


def test_a_mesh_cut_by_the_procedure_filter_is_consistent(tmp_path: Path) -> None:
    old, new = base_spec(), base_spec()
    new.nearby["H1"] = [("H9", 5), ("H2", 10)]
    report = run(tmp_path, old, new)
    assert report["nearby"]["by_class"] == {"consistent_with_procedure_filter": 1, "identical": 1}


def test_a_neighbour_missing_from_the_new_mesh_is_inconsistent(tmp_path: Path) -> None:
    old, new = base_spec(), base_spec()
    new.nearby["H1"] = [("H9", 5), ("H8", 12)]
    report = run(tmp_path, old, new)
    assert report["nearby"]["by_class"]["inconsistent"] == 1
    assert report["nearby"]["examples"][0]["hospital"] == "H1"


def test_suburbs_report_counts_and_centre_shift(tmp_path: Path) -> None:
    old, new = base_spec(), base_spec()
    new.suburbs = [("1", "Alpha", "NSW", -33.0, 151.001), ("3", "Gamma", "Qld", -27.0, 153.0)]
    report = run(tmp_path, old, new)
    suburbs = report["suburbs"]
    assert (suburbs["added"], suburbs["removed"]) == (["3"], ["2"])
    assert round(suburbs["centre_shift"]["max_m"], -1) == EXPECTED_SHIFT_M
    assert suburbs["centre_shift"]["within_1km"] == 1


def test_the_report_is_deterministic_and_the_cli_writes_it(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    new = base_spec()
    new.median[("H1", "2023-24")] = 51.0
    write_old(tmp_path / "old", base_spec())
    write_new(tmp_path / "new", new)
    outputs = [tmp_path / "a.json", tmp_path / "b.json"]
    for out in outputs:
        assert parity.main([str(tmp_path / "new"), str(tmp_path / "old"), "-o", str(out)]) == 0
    assert outputs[0].read_bytes() == outputs[1].read_bytes()
    assert json.loads(outputs[0].read_text(encoding="utf-8"))["figures"]["by_class"]["differs"] == 1
    assert "Figures compared:" in capsys.readouterr().out


def keyed(before: object, after: object) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    key = ("H1", CAT, f"2024{DASH}25", "median_wait")
    old = parity.Side(hospitals={"H1": {}}, categories={CAT: ("procedure", "x")})
    new = parity.Side(hospitals={"H1": {}}, categories={CAT: ("procedure", "x")})
    if before is not None:
        old.figures[key] = before
    if after is not None:
        new.figures[key] = after
    return parity.compare_figures(old, new)


def test_trend_points_carry_their_state_and_reason() -> None:
    gap = [2024, None, None, "not_published:no_patients_reported"]
    assert parity.trend_fig("median_wait", gap) == parity.Fig(
        "suppressed", None, "no_patients_reported"
    )
    assert parity.trend_fig("long_wait", [2024, 0.07, None]) == parity.Fig("published", 7.0)
    assert parity.trend_fig("median_wait", [2024, None, None, "not_reported:x"]) is None


def test_a_matching_suppression_reason_is_equal() -> None:
    old = parity.old_fig({"state": "not_published", "suppression_code": "X39"})
    new = parity.trend_fig("median_wait", [2024, None, None, "not_published:no_patients_reported"])
    summary, rows = keyed(old, new)
    assert rows == []
    assert summary["by_class"] == {"equal": 1}


def test_old_codes_map_to_the_new_reasons() -> None:
    codes_seen = {c: parity.old_fig({"state": "not_published", "suppression_code": c}) for c in OLD}
    assert {c: f.detail for c, f in codes_seen.items()} == OLD


def test_a_mismatched_suppression_reason_is_its_own_class() -> None:
    old = parity.old_fig({"state": "not_published", "suppression_code": "X01"})
    new = parity.trend_fig("median_wait", [2024, None, None, "not_published:not_published_by_aihw"])
    summary, rows = keyed(old, new)
    assert summary["by_class"] == {"reason_differs": 1}
    assert rows[0]["explained"] is False
    assert summary["suppression_reason_pairs"] == {"too_few_patients -> not_published_by_aihw": 1}


def test_a_new_suppressed_point_with_no_old_figure_is_only_new() -> None:
    new = parity.trend_fig("median_wait", [2024, None, None, "not_published:too_few_patients"])
    summary, rows = keyed(None, new)
    assert summary["by_class"] == {"only_new": 1}
    assert rows[0]["new"] == {"state": "suppressed", "value": None}


def test_old_benchmarks_are_counted_and_the_new_dist_has_none(tmp_path: Path) -> None:
    report = run(tmp_path, base_spec(), base_spec())
    bench = report["benchmarks"]
    assert bench["old_figures"] == bench["old_national_figures"] + bench["old_state_figures"]
    assert (bench["old_national_figures"], bench["old_state_figures"]) == (2, 2)
    assert (bench["old_published"], bench["old_suppressed"]) == (3, 1)
    assert bench["old_by_role"] == {"long_wait": 1, "median_wait": 2, "volume": 1}
    assert bench["new_figures"] == 0
    assert "no benchmark counterpart" in bench["status"]
