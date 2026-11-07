import copy
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from dataclasses import replace
from functools import cache
from pathlib import Path
from typing import Any

import pytest

import realdata
from fixture_dist import fixture_docs, fixture_inputs
from surgerywaits.contract import CONTRACT_DIR, ContractError, schema_names, validate
from surgerywaits.dist import (
    SUMS,
    DistError,
    Inputs,
    assemble,
    build_context,
    build_dist,
    network_docs,
    render,
    urgent_on_time,
    write,
)
from surgerywaits.gates import URGENT_SLUG
from surgerywaits.manifest import load
from surgerywaits.waiting_times import Table

Doc = dict[str, Any]
PERIOD = f"2024{chr(0x2013)}25"
RELEASE = "2026-08-19"
PUBLISHED: Doc = {"state": "published", "value": 68, "period": PERIOD, "release": RELEASE}
HIDDEN: Doc = {
    "state": "not_published",
    "reason": "too_few_patients",
    "period": PERIOD,
    "release": RELEASE,
}
RANKED: Doc = {"status": "ranked", "position": 1, "of": 9}
UNRANKED: Doc = {"status": "unranked", "why": "not_published"}
SCOPE: Doc = {"sector": "public", "private_excluded": ["H0001"]}
QLD_COLUMNS = (
    "treated",
    "percent_treated_in_time",
    "percent_change_treated_on_prior_year",
    "waiting",
    "long_waits",
    "percent_waiting_in_time",
    "long_waits_ready_for_surgery",
    "long_waits_not_ready_for_surgery",
    "percent_waiting_in_time_ready_for_surgery",
)
QLD_FIGURE: Doc = {
    "state": "published",
    "value": 4,
    "period": "July to September 2025",
    "release": RELEASE,
}


def _hospital_page() -> Doc:
    return copy.deepcopy(fixture_docs()["hospitals/armidale-hospital.json"][1])


def _qld_file() -> Doc:
    path = next(p for p in fixture_docs() if p.startswith("queensland/"))
    return copy.deepcopy(fixture_docs()[path][1])


def test_every_dist_file_kind_has_a_schema() -> None:
    kinds = {schema for schema, _ in fixture_docs().values()}
    assert kinds <= set(schema_names())
    assert {p.stem.removesuffix(".schema") for p in CONTRACT_DIR.glob("*.schema.json")} >= kinds


def _bad_figures() -> list[tuple[str, Doc]]:
    without_period = {k: v for k, v in PUBLISHED.items() if k != "period"}
    without_release = {k: v for k, v in PUBLISHED.items() if k != "release"}
    return [
        ("a value beside a reason", {**HIDDEN, "value": 12}),
        ("a zero standing in for a suppressed figure", {**HIDDEN, "value": 0}),
        ("a suppressed figure with a null value", {**HIDDEN, "value": None}),
        ("a published figure with a reason", {**PUBLISHED, "reason": "too_few_patients"}),
        ("a published figure with no value", {k: v for k, v in PUBLISHED.items() if k != "value"}),
        ("a published figure with a null value", {**PUBLISHED, "value": None}),
        ("a missing period", without_period),
        ("a missing release", without_release),
        ("a period that is not a financial year", {**PUBLISHED, "period": "2024-25"}),
        ("a release that is not a date", {**PUBLISHED, "release": "19 August 2026"}),
        ("a suppressed figure with no reason", {k: v for k, v in HIDDEN.items() if k != "reason"}),
        ("a reason the pipeline does not know", {**HIDDEN, "reason": "withheld"}),
        ("an unknown state", {**PUBLISHED, "state": "estimated"}),
        ("a not-reported figure with a suppression reason", {**HIDDEN, "state": "not_reported"}),
        ("an extra field", {**PUBLISHED, "display": "68 days"}),
    ]


@pytest.mark.parametrize(("label", "figure"), _bad_figures(), ids=[b[0] for b in _bad_figures()])
def test_a_bad_figure_is_rejected(label: str, figure: Doc) -> None:
    del label
    with pytest.raises(ContractError):
        validate("surgery", _surgery_with({"figure": figure, "rank": UNRANKED}))


def _trend(points: list[list[Any]]) -> Doc:
    series = {
        "kind": "urgency",
        "slug": "urgent",
        "role": "median_wait",
        "release": RELEASE,
        "periods": [f"{p[0]}{chr(0x2013)}{(p[0] + 1) % 100:02d}" for p in points],
        "points": points,
    }
    return {"code": "H0002", "slug": "x", "series": [series], "sources": ["a-source"]}


def test_good_figures_pass_including_a_published_zero() -> None:
    for figure in (
        PUBLISHED,
        HIDDEN,
        {**PUBLISHED, "value": 0},
        {**HIDDEN, "state": "not_reported", "reason": "not_reported_by_source"},
    ):
        validate("surgery", _surgery_with({"figure": figure, "rank": UNRANKED}))


def test_a_negative_published_value_is_rejected() -> None:
    with pytest.raises(ContractError):
        validate("surgery", _surgery_with({"figure": {**PUBLISHED, "value": -1}, "rank": UNRANKED}))
    with pytest.raises(ContractError):
        validate("trend", _trend([[2023, 5, None], [2024, -1, -6]]))


def test_compact_trend_points_are_strict() -> None:
    hidden = "not_published:too_few_patients"
    validate("trend", _trend([[2023, 5, None], [2024, None, None, hidden], [2025, 0, None]]))
    for bad in (
        [[2023, 5, None], [2024, None, None]],
        [[2023, 5, None], [2024, None, None, "withheld"]],
        [[2023, 5, None], [2024, 6, None, hidden]],
        [[2023, 5, None], [2024, None, 3, hidden]],
        [[2023, 5, None], [2024, 6, 1, "x"]],
        [[2023, 5, None], [2024, 6]],
    ):
        with pytest.raises(ContractError):
            validate("trend", _trend(bad))
    extra = _trend([[2023, 5, None], [2024, 6, 1]])
    extra["series"][0]["note"] = "x"
    with pytest.raises(ContractError):
        validate("trend", extra)


def _surgery_with(measure: Doc) -> Doc:
    page = copy.deepcopy(next(d for s, d in fixture_docs().values() if s == "surgery"))
    page["hospitals"][0]["measures"] = {"median_wait": measure}
    return page


@pytest.mark.parametrize(
    "measure",
    [
        {"figure": HIDDEN, "rank": RANKED},
        {"figure": PUBLISHED, "rank": {"status": "ranked", "position": 1}},
        {"figure": PUBLISHED, "rank": {"status": "ranked", "of": 3}},
        {"figure": PUBLISHED, "rank": {"status": "ranked", "position": 0, "of": 3}},
        {"figure": PUBLISHED},
        {"figure": PUBLISHED, "rank": RANKED, "display": "68 days"},
    ],
    ids=[
        "a ranked suppressed figure",
        "a rank with no cohort size",
        "a cohort size with no position",
        "a rank of zero",
        "a figure with no rank field",
        "an extra field",
    ],
)
def test_a_bad_measure_is_rejected(measure: Doc) -> None:
    with pytest.raises(ContractError):
        validate("surgery", _surgery_with(measure))


def test_good_measures_pass() -> None:
    validate("surgery", _surgery_with({"figure": PUBLISHED, "rank": RANKED}))
    validate("surgery", _surgery_with({"figure": HIDDEN, "rank": UNRANKED}))
    validate("surgery", _surgery_with({"figure": PUBLISHED, "rank": {**UNRANKED, "why": "stale"}}))


def test_the_hospital_page_rejects_missing_scope_and_unknown_fields() -> None:
    validate("hospital", _hospital_page())
    page = _hospital_page()
    del page["scope"]
    with pytest.raises(ContractError, match="scope"):
        validate("hospital", page)
    page = _hospital_page()
    page["rank"] = 1
    with pytest.raises(ContractError):
        validate("hospital", page)
    page = _hospital_page()
    page["scope"] = {"sector": "private", "private_excluded": []}
    with pytest.raises(ContractError):
        validate("hospital", page)


def test_queensland_figures_carry_no_rank_and_need_every_column() -> None:
    qld = _qld_file()
    validate("queensland", qld)
    ranked = copy.deepcopy(qld)
    ranked["quarters"][0]["total"]["treated"] = {"figure": QLD_FIGURE, "rank": RANKED}
    with pytest.raises(ContractError):
        validate("queensland", ranked)
    for extra in ("rank", "trend", "national"):
        added = copy.deepcopy(qld)
        added["quarters"][0]["total"][extra] = 1
        with pytest.raises(ContractError):
            validate("queensland", added)
    short = copy.deepcopy(qld)
    del short["quarters"][0]["total"]["waiting"]
    with pytest.raises(ContractError):
        validate("queensland", short)
    zero = copy.deepcopy(qld)
    zero["quarters"][0]["total"]["waiting"] = {**QLD_FIGURE, "state": "not_published", "value": 0}
    with pytest.raises(ContractError):
        validate("queensland", zero)
    assert set(qld["quarters"][0]["total"]) == set(QLD_COLUMNS)


def test_a_trend_needs_two_periods_and_a_suburb_needs_five_fields() -> None:
    trend = _trend([[2023, 5, None], [2024, 6, 1]])
    trend["series"][0]["points"].pop()
    with pytest.raises(ContractError):
        validate("trend", trend)
    with pytest.raises(ContractError):
        validate("suburbs", {"suburbs": [["1", "Place", "NSW", -33.0]]})
    with pytest.raises(ContractError):
        validate("suburbs", {"suburbs": [["1", "Place", "NSW", -33.0, 151.0, "extra"]]})


def test_the_index_states_the_exclusion_of_private_hospitals() -> None:
    index = fixture_docs()["index.json"][1]
    assert index["scope"]["sector"] == "public"
    assert index["scope"]["private_excluded"] == sorted(fixture_inputs().register.excluded_private)
    without = copy.deepcopy(index)
    del without["scope"]
    with pytest.raises(ContractError):
        validate("index", without)


def test_the_fixture_dist_validates_and_counts_its_own_files() -> None:
    files = render(fixture_docs())
    assert set(files) - {SUMS} == set(fixture_docs())
    index = json.loads(files["index.json"])
    assert index["counts"]["files"] == len(files) - 1


def _credit_slugs(files: dict[str, bytes]) -> set[str]:
    return {s["slug"] for s in json.loads(files["credits.json"])["sources"]}


def _check_sources(files: dict[str, bytes]) -> None:
    credited = _credit_slugs(files)
    assert credited == {e.slug for e in load()}
    for path, data in files.items():
        if path.endswith(".json") and path != "credits.json":
            listed = json.loads(data)["sources"]
            assert listed == sorted(listed), path
            assert set(listed) <= credited, path


def test_every_manifest_entry_the_build_reads_is_credited_and_every_listed_source_exists() -> None:
    files = render(fixture_docs())
    _check_sources(files)
    assert set(json.loads(files["suburbs.json"])["sources"]) == {"abs-suburbs-localities-2021"}
    assert "au-myhospitals-reported-measures" in json.loads(files["hospitals.json"])["sources"]


def test_a_failure_part_way_through_writing_leaves_the_previous_dist_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out = tmp_path / "dist"
    files = render(fixture_docs())
    write(files, out)
    before = (out / SUMS).read_bytes()
    calls = 0
    original = Path.write_bytes

    def flaky(self: Path, data: bytes) -> int:
        nonlocal calls
        calls += 1
        if calls == 5:  # noqa: PLR2004
            msg = "disk full"
            raise OSError(msg)
        return original(self, data)

    monkeypatch.setattr(Path, "write_bytes", flaky)
    with pytest.raises(OSError, match="disk full"):
        write(files, out)
    monkeypatch.undo()
    assert (out / SUMS).read_bytes() == before
    assert sorted(p.name for p in tmp_path.iterdir()) == ["dist"]
    fresh = tmp_path / "fresh"
    calls = 0
    monkeypatch.setattr(Path, "write_bytes", flaky)
    with pytest.raises(OSError, match="disk full"):
        write(files, fresh)
    monkeypatch.undo()
    assert not fresh.exists()
    assert sorted(p.name for p in tmp_path.iterdir()) == ["dist"]


def test_a_checksum_mismatch_stops_the_swap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out = tmp_path / "dist"
    files = render(fixture_docs())
    write(files, out)
    original = Path.write_bytes

    def corrupt(self: Path, data: bytes) -> int:
        return original(self, data + b" " if self.name == "index.json" else data)

    monkeypatch.setattr(Path, "write_bytes", corrupt)
    with pytest.raises(DistError, match=r"index\.json"):
        write(files, out)
    monkeypatch.undo()
    assert (out / "index.json").read_bytes() == files["index.json"]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["dist"]


def test_a_ranked_figure_comes_with_its_cohort_and_a_suppressed_one_is_never_ranked() -> None:
    seen_ranked = seen_hidden = False
    for path, (schema, doc) in fixture_docs().items():
        if schema != "surgery":
            continue
        ranks = [
            m["rank"]["position"]
            for h in doc["hospitals"]
            for m in [h["measures"].get("median_wait")]
            if m and m["rank"]["status"] == "ranked"
        ]
        for h in doc["hospitals"]:
            for m in h["measures"].values():
                if m["rank"]["status"] == "ranked":
                    seen_ranked = True
                    assert m["figure"]["state"] == "published", path
                    assert m["rank"]["position"] <= m["rank"]["of"], path
                else:
                    seen_hidden = seen_hidden or m["figure"]["state"] != "published"
        assert ranks == sorted(ranks), path
    assert seen_ranked
    assert seen_hidden


def test_dist_is_written_with_sorted_keys_and_a_checksum_for_every_file(tmp_path: Path) -> None:
    out = tmp_path / "dist"
    files = build_dist(fixture_inputs(), out)
    for path, data in files.items():
        assert (out / path).read_bytes() == data
        assert data.endswith(b"\n")
    for path in (p for p in files if p.endswith(".json")):
        text = files[path].decode("utf-8")
        assert (
            json.dumps(json.loads(text), sort_keys=True, ensure_ascii=False, separators=(",", ":"))
            + "\n"
            == text
        )
    lines = files[SUMS].decode().splitlines()
    assert [ln.split("  ")[1] for ln in lines] == sorted(set(files) - {SUMS})
    for line in lines:
        digest, path = line.split("  ")
        assert hashlib.sha256((out / path).read_bytes()).hexdigest() == digest


def test_a_file_that_breaks_its_contract_stops_the_build_before_anything_is_written(
    tmp_path: Path,
) -> None:
    docs = dict(fixture_docs())
    page = _hospital_page()
    page["state"] = "Atlantis"
    docs["hospitals/armidale-hospital.json"] = ("hospital", page)
    with pytest.raises(DistError, match="armidale-hospital"):
        render(docs)
    assert list(tmp_path.iterdir()) == []


def test_a_directory_that_is_not_a_dist_is_never_cleared(tmp_path: Path) -> None:
    (tmp_path / "keep.txt").write_text("mine", encoding="utf-8")
    with pytest.raises(DistError, match="not a dist"):
        write(render(fixture_docs()), tmp_path)
    assert (tmp_path / "keep.txt").read_text(encoding="utf-8") == "mine"
    write(render(fixture_docs()), tmp_path / "fresh")
    write(render(fixture_docs()), tmp_path / "fresh")
    assert not (tmp_path / "fresh" / "keep.txt").exists()


class _FrozenDateTime(dt.datetime):
    @classmethod
    def now(cls, tz: dt.tzinfo | None = None) -> "_FrozenDateTime":
        return cls(2099, 12, 31, 23, 59, 59, tzinfo=tz)

    @classmethod
    def utcnow(cls) -> "_FrozenDateTime":
        return cls(2099, 12, 31, 23, 59, 59)


class _FrozenDate(dt.date):
    @classmethod
    def today(cls) -> "_FrozenDate":
        return cls(2099, 12, 31)


def test_a_build_under_a_frozen_clock_is_byte_identical(monkeypatch: pytest.MonkeyPatch) -> None:
    before = render(assemble(fixture_inputs()))
    monkeypatch.setattr(time, "time", lambda: 4102444800.0)
    monkeypatch.setattr(time, "monotonic", lambda: 1.0)
    monkeypatch.setattr(dt, "datetime", _FrozenDateTime)
    monkeypatch.setattr(dt, "date", _FrozenDate)
    assert render(assemble(fixture_inputs())) == before


CLOCK = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\b\d{2}:\d{2}:\d{2}\b|\b1[5-9]\d{8}\b")
DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _known_dates(overlay_dates: set[str]) -> set[str]:
    fields = ("version", "release", "as_at")
    return {getattr(e, f) for e in load() for f in fields if getattr(e, f, None)} | overlay_dates


def scan_for_clock(files: dict[str, bytes], overlay_dates: set[str]) -> None:
    known = _known_dates(overlay_dates)
    for path, data in files.items():
        if path == SUMS:
            continue
        text = data.decode("utf-8")
        assert not CLOCK.search(text), path
        assert set(DATE.findall(text)) <= known, path


def overlay_dates(inputs: Inputs) -> set[str]:
    records = inputs.overlay.records
    return {r.release_date.isoformat() for r in records} | {
        r.quarter.end.isoformat() for r in records
    }


def test_no_file_holds_a_date_or_time_outside_the_sources() -> None:
    scan_for_clock(render(fixture_docs()), overlay_dates(fixture_inputs()))


def test_the_hash_seed_does_not_change_the_fixture_build() -> None:
    tests = Path(__file__).parent
    code = (
        "from fixture_dist import fixture_docs\n"
        "from surgerywaits.dist import SUMS, render\n"
        "import sys\n"
        "sys.stdout.write(render(fixture_docs())[SUMS].decode())\n"
    )
    sums: set[str] = set()
    for seed in ("1", "2718"):
        env = {**os.environ, "PYTHONHASHSEED": seed, "PYTHONPATH": str(tests)}
        run = subprocess.run(  # noqa: S603
            [sys.executable, "-c", code], env=env, capture_output=True, text=True, check=True
        )
        sums.add(run.stdout)
    assert len(sums) == 1


@cache
def _real_build() -> tuple[Inputs, dict[str, bytes], bytes]:
    from surgerywaits.build import read_inputs  # noqa: PLC0415

    entries = load()
    paths = dict(
        zip((e.slug for e in entries), realdata.pinned(*(e.slug for e in entries)), strict=True)
    )
    scratch = Path(tempfile.mkdtemp(prefix="sw-real-dist-"))
    try:
        inputs = read_inputs(entries, paths)
        first = build_dist(inputs, scratch / "one")
        second = build_dist(read_inputs(entries, paths), scratch / "two")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    assert first[SUMS] == second[SUMS]
    return inputs, first, second[SUMS]


def real_docs() -> dict[str, Any]:
    _, files, _ = _real_build()
    return {p: json.loads(d) for p, d in files.items() if p.endswith(".json")}


def test_the_real_dist_builds_twice_to_the_same_checksums_and_reports_its_size(
    record_property: Callable[[str, object], None],
) -> None:
    _, files, again = _real_build()
    assert files[SUMS] == again
    total = sum(len(b) for b in files.values())
    largest = max(files, key=lambda p: len(files[p]))
    trends = sum(len(b) for p, b in files.items() if p.startswith("trends/"))
    sys.stdout.write(
        f"dist: {len(files)} files, {total} bytes, trends {trends}, largest {largest}\n"
    )
    record_property("files", len(files))
    record_property("bytes", total)
    record_property("trend_bytes", trends)
    index = json.loads(files["index.json"])
    assert index["counts"]["files"] == len(files) - 1
    assert index["counts"]["hospitals_with_figures"] == 293  # noqa: PLR2004
    assert len(re.findall(r"\n", files[SUMS].decode())) == len(files) - 1
    # A static site holds a few hundred to a few thousand files, none of them large.
    assert len(files) < 2000  # noqa: PLR2004
    assert len(files[largest]) < 1_000_000  # noqa: PLR2004


def test_the_real_dist_credits_every_source_and_holds_no_stray_dates() -> None:
    inputs, files, _ = _real_build()
    _check_sources(files)
    scan_for_clock(files, overlay_dates(inputs))


def test_every_real_rank_sits_inside_its_cohort() -> None:
    ranked = 0
    for path, doc in real_docs().items():
        if not path.startswith(("hospitals/", "surgeries/")):
            continue
        entries = doc["hospitals"] if path.startswith("surgeries/") else doc["surgeries"]
        for entry in entries:
            for m in entry["measures"].values():
                if m["rank"]["status"] == "ranked":
                    ranked += 1
                    assert 1 <= m["rank"]["position"] <= m["rank"]["of"], path
    assert ranked > 0


def test_every_real_trend_change_is_the_difference_of_two_published_points() -> None:
    changes = 0
    for path, doc in real_docs().items():
        if not path.startswith("trends/"):
            continue
        for series in doc["series"]:
            points, periods = series["points"], series["periods"]
            assert len(points) == len(periods), path
            for i, point in enumerate(points):
                assert periods[i].startswith(str(point[0])), path
                if i:
                    assert point[0] > points[i - 1][0], path
                if len(point) == 4:  # noqa: PLR2004
                    continue
                change = point[2]
                if change is None:
                    continue
                changes += 1
                before = points[i - 1]
                assert i > 0
                assert before[1] is not None, path
                assert point[0] == before[0] + 1, path
                assert abs(change - (point[1] - before[1])) < 1e-9, path  # noqa: PLR2004
    assert changes > 0


def test_every_real_hospital_surgery_says_whether_it_is_stale() -> None:
    docs = real_docs()
    newest = {t["kind"]: t["newest_period"] for t in docs["index.json"]["tables"]}
    stale = 0
    for path, doc in docs.items():
        if not path.startswith("hospitals/"):
            continue
        for s in doc["surgeries"]:
            periods = {m["figure"]["period"] for m in s["measures"].values()}
            assert s["stale"] == (periods != {newest[s["kind"]]}), path
            if s["stale"]:
                stale += 1
                assert all(m["rank"]["status"] == "unranked" for m in s["measures"].values()), path
    assert stale > 0


def test_a_hospital_without_the_stale_field_is_rejected() -> None:
    page = _hospital_page()
    assert isinstance(page["surgeries"][0]["stale"], bool)
    del page["surgeries"][0]["stale"]
    with pytest.raises(ContractError, match="stale"):
        validate("hospital", page)


def test_the_hospital_index_carries_each_network_code_and_name() -> None:
    rows = real_docs()["hospitals.json"]["hospitals"]
    mapped = [r["network"] for r in rows if r["network"] is not None]
    assert mapped
    assert all(set(n) == {"code", "name", "slug"} for n in mapped)


def test_a_renamed_urgent_category_stops_the_build() -> None:
    ctx = build_context(fixture_inputs())
    renamed = {
        k: ("urgent-surgery", v[1]) if v[0] == URGENT_SLUG else v for k, v in ctx.categories.items()
    }
    with pytest.raises(DistError, match="urgent-elective-surgery"):
        network_docs(replace(ctx, categories=renamed))


def test_the_urgent_figure_says_why_it_is_absent() -> None:
    ctx = build_context(fixture_inputs())
    stamp = {"period": ctx.newest[Table.URGENCY], "release": ctx.release_of[Table.URGENCY]}
    assert urgent_on_time(ctx, None) == {"status": "missing", "figure": None, **stamp}
    old = next(o for o in ctx.latest.values() if o.table is Table.URGENCY)
    stale = replace(old, period="1999-00")
    assert urgent_on_time(ctx, stale)["status"] == "stale"
