import copy
import json
from collections.abc import Callable
from dataclasses import replace
from datetime import date, timedelta
from typing import Any

import pytest

import realdata
from fixture_dist import fixture_docs, fixture_inputs
from surgerywaits.build import read_inputs
from surgerywaits.contract import ContractError, validate
from surgerywaits.dist import TABLE_SOURCES, Doc, assemble, render
from surgerywaits.gates import (
    ALLOWED_LICENCES,
    MAX_PERIOD_AGE_YEARS,
    MAX_QLD_LAG_DAYS,
    URGENT_SLUG,
    GateError,
    check_docs,
    check_freshness,
)
from surgerywaits.manifest import SCHEMA_PATH, Entry, load
from surgerywaits.queensland import Quarter
from test_dist import overlay_dates, scan_for_clock

DASH = chr(0x2013)
ENTRIES = load()
KINDS = ("urgency", "procedure", "specialty")
TABLES = tuple(TABLE_SOURCES.values())
URGENCY = TABLE_SOURCES[next(iter(TABLE_SOURCES))]


def _docs() -> dict[str, tuple[str, Doc]]:
    return copy.deepcopy(fixture_docs())


def _newest() -> dict[str, str]:
    return {TABLE_SOURCES[t]: p for t, p in fixture_inputs().derived.newest_periods}


def _entries(slug: str, **changes: Any) -> tuple[Entry, ...]:  # noqa: ANN401
    return tuple(replace(e, **changes) if e.slug == slug else e for e in ENTRIES)


def _hospital_path(docs: dict[str, tuple[str, Doc]]) -> str:
    return next(p for p, (k, _) in sorted(docs.items()) if k == "hospital")


def test_the_allow_list_matches_the_manifest_schema() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    assert set(schema["$defs"]["entry"]["properties"]["licence"]["enum"]) == ALLOWED_LICENCES


def test_every_credit_matches_the_manifest_and_carries_an_allowed_licence() -> None:
    check_docs(ENTRIES, fixture_docs())
    docs = _docs()
    docs["credits.json"][1]["sources"][0]["licence"] = "All-rights-reserved"
    with pytest.raises(GateError, match="does not match the manifest"):
        check_docs(ENTRIES, docs)
    unlicensed = _entries(ENTRIES[0].slug, licence="All-rights-reserved")
    with pytest.raises(GateError, match="allow-list"):
        assemble(replace(fixture_inputs(), entries=unlicensed))


def test_a_credit_that_drifts_from_the_manifest_is_caught() -> None:
    for field, value in (
        ("sha256", "0" * 64),
        ("citation", "Someone else."),
        ("title", "Another title"),
        ("publisher", {"name": "Someone else", "url": "https://else.example/"}),
        ("dataset_url", "https://publicdata.au/d/other/v/2020-01-01/"),
        ("version", "2020-01-01"),
    ):
        docs = _docs()
        docs["credits.json"][1]["sources"][0][field] = value
        with pytest.raises(GateError, match="does not match the manifest"):
            check_docs(ENTRIES, docs)


def test_a_file_citing_an_uncredited_source_is_caught() -> None:
    docs = _docs()
    path = _hospital_path(docs)
    docs[path][1]["sources"].append("not-in-the-manifest")
    with pytest.raises(GateError, match="no credit"):
        check_docs(ENTRIES, docs)


def test_the_fixture_build_is_fresh() -> None:
    check_freshness(ENTRIES, _newest(), TABLES, fixture_inputs().overlay.records)


def test_a_table_too_old_for_its_release_fails() -> None:
    old = dict.fromkeys(_newest(), f"{2026 - MAX_PERIOD_AGE_YEARS - 1}{DASH}25")
    with pytest.raises(GateError, match="years from release"):
        check_freshness(ENTRIES, old, TABLES, ())
    future = dict.fromkeys(_newest(), f"2027{DASH}28")
    with pytest.raises(GateError, match="years from release"):
        check_freshness(ENTRIES, future, TABLES, ())


def test_a_release_that_disagrees_with_its_as_at_fails() -> None:
    entries = _entries(URGENCY, release="2025081901")
    with pytest.raises(GateError, match="disagrees"):
        check_freshness(entries, _newest(), TABLES, ())


def test_a_version_older_than_its_release_fails() -> None:
    entries = _entries(URGENCY, version="2026-08-01")
    with pytest.raises(GateError, match="older than its release"):
        check_freshness(entries, _newest(), TABLES, ())


def test_a_table_with_no_release_fails() -> None:
    entries = _entries(URGENCY, release=None, as_at=None)
    with pytest.raises(GateError, match="no release"):
        check_freshness(entries, _newest(), TABLES, ())


def test_a_queensland_quarter_outside_its_release_fails() -> None:
    record = fixture_inputs().overlay.records[0]
    for end, release in (
        (Quarter(2025, 3), date(2025, 9, 1)),
        (Quarter(2023, 3), date(2025, 10, 28)),
        (Quarter(2025, 3), date(2025, 9, 30) + timedelta(days=MAX_QLD_LAG_DAYS + 1)),
    ):
        bad = replace(record, quarter=end, release_date=release)
        with pytest.raises(GateError, match="days after it ended"):
            check_freshness(ENTRIES, _newest(), TABLES, (bad,))


def test_the_pinned_releases_are_fresh() -> None:
    entries = load()
    paths = dict(
        zip((e.slug for e in entries), realdata.pinned(*(e.slug for e in entries)), strict=True)
    )
    inputs = read_inputs(entries, paths)
    check_freshness(
        entries,
        {TABLE_SOURCES[t]: p for t, p in inputs.derived.newest_periods},
        TABLES,
        inputs.overlay.records,
    )


def test_hospital_slugs_must_be_unique_and_url_safe() -> None:
    docs = _docs()
    rows = docs["hospitals.json"][1]["hospitals"]
    rows[0]["slug"] = rows[1]["slug"]
    with pytest.raises(GateError, match="different slugs"):
        check_docs(ENTRIES, docs)
    docs = _docs()
    first, second = [p for p, (k, _) in sorted(docs.items()) if k == "hospital"][:2]
    docs[second][1]["slug"] = docs[first][1]["slug"]
    docs["hospitals.json"][1]["hospitals"][1]["slug"] = docs[first][1]["slug"]
    with pytest.raises(GateError, match="used twice"):
        check_docs(ENTRIES, docs)
    docs = _docs()
    docs[first][1]["slug"] = "Not URL safe/"
    with pytest.raises(GateError, match="not URL-safe"):
        check_docs(ENTRIES, docs)


def test_surgery_slugs_are_unique_within_their_kind() -> None:
    docs = _docs()
    rows = docs["surgeries.json"][1]["surgeries"]
    same = [r for r in rows if r["kind"] == rows[0]["kind"]]
    same[1]["slug"] = same[0]["slug"]
    with pytest.raises(GateError, match=r"surgery slug .* used twice"):
        check_docs(ENTRIES, docs)
    docs = _docs()
    docs["surgeries.json"][1]["surgeries"][0]["slug"] = "has_underscore"
    with pytest.raises(GateError, match="not URL-safe"):
        check_docs(ENTRIES, docs)


def test_suburb_codes_are_unique_and_a_network_keeps_one_name() -> None:
    docs = _docs()
    suburbs = docs["suburbs.json"][1]["suburbs"]
    suburbs[1][0] = suburbs[0][0]
    with pytest.raises(GateError, match="suburb code"):
        check_docs(ENTRIES, docs)
    docs = _docs()
    named = [d for _, (k, d) in sorted(docs.items()) if k == "hospital" and d["network"]]
    assert len(named) > 1
    named[1]["network"] = {"code": named[0]["network"]["code"], "name": "Another network"}
    with pytest.raises(GateError, match="two names"):
        check_docs(ENTRIES, docs)


def _trend() -> Doc:
    doc = next(d for _, (k, d) in sorted(fixture_docs().items()) if k == "trend")
    return copy.deepcopy(doc)


def test_a_clean_trend_passes_the_semantic_rules() -> None:
    validate("trend", _trend())


def test_a_trend_with_the_wrong_number_of_points_fails() -> None:
    doc = _trend()
    series = doc["series"][0]
    series["points"] = [*series["points"], series["points"][-1]]
    with pytest.raises(ContractError, match="points for"):
        validate("trend", doc)


def test_a_period_that_does_not_start_with_its_year_fails() -> None:
    doc = _trend()
    doc["series"][0]["periods"][0] = f"1999{DASH}00"
    with pytest.raises(ContractError, match="start with its point's year"):
        validate("trend", doc)


def test_years_that_do_not_increase_fail() -> None:
    doc = _trend()
    series = doc["series"][0]
    series["points"].reverse()
    series["periods"].reverse()
    with pytest.raises(ContractError, match="strictly increasing"):
        validate("trend", doc)


def test_a_first_point_with_a_change_fails() -> None:
    doc = _trend()
    doc["series"][0]["points"][0] = [doc["series"][0]["points"][0][0], 5, 1]
    with pytest.raises(ContractError, match="first point has a change"):
        validate("trend", doc)


def test_a_timestamp_or_unknown_date_in_dist_fails_the_clock_scan() -> None:
    files = render(fixture_docs())
    known = overlay_dates(fixture_inputs())
    scan_for_clock(files, known)
    stamped = {**files, "index.json": files["index.json"] + b'{"built":"2026-11-06T10:15:00"}'}
    with pytest.raises(AssertionError):
        scan_for_clock(stamped, known)
    dated = {**files, "index.json": files["index.json"] + b'{"on":"2031-01-01"}'}
    with pytest.raises(AssertionError):
        scan_for_clock(dated, known)


def test_a_build_with_a_stale_table_stops_before_rendering() -> None:
    inputs = fixture_inputs()
    old = replace(
        inputs.derived,
        newest_periods=tuple((t, f"2019{DASH}20") for t, _ in inputs.derived.newest_periods),
    )
    with pytest.raises(GateError, match="years from release"):
        assemble(replace(inputs, derived=old))


def test_freshness_needs_every_table_and_a_non_empty_map() -> None:
    with pytest.raises(GateError, match="no table periods"):
        check_freshness(ENTRIES, {}, TABLES, ())
    partial = dict(list(_newest().items())[:1])
    with pytest.raises(GateError, match="tables with no period"):
        check_freshness(ENTRIES, partial, TABLES, ())


def test_a_released_dataset_outside_the_tables_is_checked_for_agreement() -> None:
    slug = "au-hospitals-myhospitals"
    with pytest.raises(GateError, match="disagrees"):
        check_freshness(_entries(slug, release="2020010101"), _newest(), TABLES, ())


def test_a_malformed_credit_raises_a_gate_error() -> None:
    docs = _docs()
    del docs["credits.json"][1]["sources"][0]["url"]
    with pytest.raises(GateError, match="exactly the credit keys"):
        check_docs(ENTRIES, docs)
    docs = _docs()
    docs["credits.json"][1]["sources"][0]["extra"] = "x"
    with pytest.raises(GateError, match="exactly the credit keys"):
        check_docs(ENTRIES, docs)
    docs = _docs()
    docs["credits.json"][1]["sources"][0] = "not a credit"
    with pytest.raises(GateError, match="exactly the credit keys"):
        check_docs(ENTRIES, docs)


def test_a_file_without_sources_is_caught() -> None:
    docs = _docs()
    del docs[_hospital_path(docs)][1]["sources"]
    with pytest.raises(GateError, match="lists no sources"):
        check_docs(ENTRIES, docs)


def test_surgery_files_must_match_the_index_and_be_url_safe() -> None:
    docs = _docs()
    path = next(p for p, (k, _) in sorted(docs.items()) if k == "surgery")
    docs[path][1]["slug"] = "other-slug"
    with pytest.raises(GateError, match="surgery index and the surgery files"):
        check_docs(ENTRIES, docs)
    docs = _docs()
    docs[path][1]["slug"] = "Bad Slug"
    with pytest.raises(GateError, match=r"file slug .* not URL-safe"):
        check_docs(ENTRIES, docs)


def test_a_network_code_is_checked_for_url_safety_as_written() -> None:
    docs = _docs()
    named = next(d for _, (k, d) in sorted(docs.items()) if k == "hospital" and d["network"])
    named["network"]["code"] = "N 1/x"
    with pytest.raises(GateError, match=r"network code .* not URL-safe"):
        check_docs(ENTRIES, docs)


def test_a_period_ending_in_the_wrong_year_fails() -> None:
    doc = _trend()
    series = doc["series"][0]
    year = series["points"][0][0]
    series["periods"][0] = f"{year}{DASH}{(year + 5) % 100:02d}"
    with pytest.raises(ContractError, match="does not end the year after"):
        validate("trend", doc)


def test_a_change_without_a_published_previous_year_fails() -> None:
    doc = _trend()
    series = doc["series"][0]
    first, second = series["points"][:2]
    series["points"][0] = [first[0], None, None, "not_published:too_few_patients"]
    series["points"][1] = [second[0], 5, 2]
    with pytest.raises(ContractError, match="year before"):
        validate("trend", doc)
    series["points"][0] = [first[0], 3, None]
    series["periods"][1] = f"{second[0]}{DASH}{(second[0] + 1) % 100:02d}"
    series["points"][1] = [second[0] + 1, 5, 2]
    series["periods"][1] = f"{second[0] + 1}{DASH}{(second[0] + 2) % 100:02d}"
    with pytest.raises(ContractError, match="year before"):
        validate("trend", doc)


def _member(docs: dict[str, tuple[str, Doc]], position: int = 0) -> tuple[Doc, Doc]:
    network = next(d for _, (k, d) in sorted(docs.items()) if k == "health-service")
    return network, network["hospitals"][position]


def _hospital_of(docs: dict[str, tuple[str, Doc]], slug: str) -> Doc:
    return next(d for _, (k, d) in sorted(docs.items()) if k == "hospital" and d["slug"] == slug)


def test_a_clean_dist_passes_the_network_member_checks() -> None:
    check_docs(ENTRIES, _docs())


def test_a_member_whose_hospital_moved_to_another_network_fails() -> None:
    docs = _docs()
    _, member = _member(docs)
    _hospital_of(docs, member["slug"])["network"]["code"] = "OTHER"
    with pytest.raises(GateError, match=r"different network|different slugs|two names"):
        check_docs(ENTRIES, docs)


def test_a_network_renamed_in_its_file_alone_fails() -> None:
    docs = _docs()
    network, _ = _member(docs)
    network["name"] = "Renamed network"
    with pytest.raises(GateError, match="different network"):
        check_docs(ENTRIES, docs)


@pytest.mark.parametrize(
    ("field", "value"),
    [("state", "Tas"), ("name", "Another hospital"), ("closed", True)],
)
def test_a_member_that_differs_from_its_hospital_file_fails(field: str, value: object) -> None:
    docs = _docs()
    _, member = _member(docs)
    member[field] = value
    with pytest.raises(GateError, match="disagrees with the hospital file"):
        check_docs(ENTRIES, docs)


def test_a_member_with_altered_figures_fails() -> None:
    docs = _docs()
    _, member = _member(docs)
    member["surgeries"]["count"] += 1
    with pytest.raises(GateError, match="disagrees with the hospital file"):
        check_docs(ENTRIES, docs)
    docs = _docs()
    network, _ = _member(docs)
    published = next(
        m for m in network["hospitals"] if m["urgent_on_time"]["status"] == "published"
    )
    published["urgent_on_time"]["figure"]["value"] += 1
    with pytest.raises(GateError, match="disagrees with the hospital file"):
        check_docs(ENTRIES, docs)
    docs = _docs()
    network, _ = _member(docs)
    network["hospitals"][0]["urgent_on_time"]["status"] = "stale"
    with pytest.raises(GateError, match="disagrees with the hospital file"):
        check_docs(ENTRIES, docs)


def _networks(docs: dict[str, tuple[str, Doc]]) -> list[Doc]:
    return [d for _, (k, d) in sorted(docs.items()) if k == "health-service"]


def _hospital_with_urgent(
    docs: dict[str, tuple[str, Doc]], *, stale: bool, published: bool = True
) -> Doc:
    def wanted(s: Doc) -> bool:
        states = {m["figure"]["state"] for m in s["measures"].values()}
        return (
            s["slug"] == URGENT_SLUG
            and s["stale"] == stale
            and ("published" in states) == published
        )

    found = [
        d
        for _, (k, d) in sorted(docs.items())
        if k == "hospital" and d["network"] and any(wanted(s) for s in d["surgeries"])
    ]
    assert found
    return found[0]


def _member_of(docs: dict[str, tuple[str, Doc]], hospital: Doc) -> Doc:
    network = next(n for n in _networks(docs) if n["code"] == hospital["network"]["code"])
    return next(m for m in network["hospitals"] if m["slug"] == hospital["slug"])


def test_a_member_stamped_with_another_period_fails() -> None:
    docs = _docs()
    _, member = _member(docs)
    assert member["surgeries"]["current"]
    member["surgeries"]["current"][0]["period"] = "1999\u201300"
    with pytest.raises(GateError, match="disagrees with the hospital file"):
        check_docs(ENTRIES, docs)


def test_a_member_lists_only_the_tables_where_it_has_a_current_figure() -> None:
    members = [m for n in _networks(_docs()) for m in n["hospitals"]]
    assert len({len(m["surgeries"]["current"]) for m in members}) > 1
    for m in members:
        assert (m["surgeries"]["count"] == 0) == (not m["surgeries"]["current"])
        assert len(m["surgeries"]["current"]) <= m["surgeries"]["count"]


def test_a_member_that_lists_a_table_it_has_no_current_figure_in_fails() -> None:
    docs = _docs()
    members = [m for n in _networks(docs) for m in n["hospitals"]]
    stamp = next(m["surgeries"]["current"][0] for m in members if m["surgeries"]["current"])
    short = next(m for m in members if len(m["surgeries"]["current"]) < len(KINDS))
    listed = {c["kind"] for c in short["surgeries"]["current"]}
    spare = next(k for k in KINDS if k not in listed)
    short["surgeries"]["current"].append({**stamp, "kind": spare})
    with pytest.raises(GateError, match="disagrees with the hospital file"):
        check_docs(ENTRIES, docs)


def test_a_stale_urgent_figure_carries_the_hospitals_own_period() -> None:
    docs = _docs()
    hospital = _hospital_with_urgent(docs, stale=True)
    member = _member_of(docs, hospital)
    own = next(s for s in hospital["surgeries"] if s["slug"] == URGENT_SLUG)["measures"]
    figure = next(iter(own.values()))["figure"]
    assert member["urgent_on_time"] == {
        "status": "stale",
        "figure": None,
        "period": figure["period"],
        "release": figure["release"],
    }
    member["urgent_on_time"]["period"] = "1999\u201300"
    with pytest.raises(GateError, match="disagrees with the hospital file"):
        check_docs(ENTRIES, docs)


def test_a_missing_urgent_figure_carries_no_period_or_release() -> None:
    docs = _docs()
    hospital = _hospital_with_urgent(docs, stale=False, published=False)
    hospital["surgeries"] = [s for s in hospital["surgeries"] if s["slug"] != URGENT_SLUG]
    member = _member_of(docs, hospital)
    member["urgent_on_time"] = {
        "status": "missing",
        "figure": None,
        "period": None,
        "release": None,
    }
    check_docs(ENTRIES, docs)
    member["urgent_on_time"]["period"] = _any_period(docs)
    with pytest.raises(GateError, match="disagrees with the hospital file"):
        check_docs(ENTRIES, docs)


def _any_period(docs: dict[str, tuple[str, Doc]]) -> str:
    return next(
        m["surgeries"]["current"][0]["period"] for m in _members(docs) if m["surgeries"]["current"]
    )


def _members(docs: dict[str, tuple[str, Doc]]) -> list[Doc]:
    return [m for n in _networks(docs) for m in n["hospitals"]]


def _break_index_count(docs: dict[str, tuple[str, Doc]]) -> None:
    _index_row(docs)["hospitals"] += 1


def _break_index_display_name(docs: dict[str, tuple[str, Doc]]) -> None:
    _index_row(docs)["display_name"] = "Other"


def _break_index_states(docs: dict[str, tuple[str, Doc]]) -> None:
    _index_row(docs)["states"] = [*_index_row(docs)["states"], "Tas"]


def _break_file_states(docs: dict[str, tuple[str, Doc]]) -> None:
    network = _networks(docs)[0]
    network["states"] = [*network["states"], "Tas"]


def _break_scope(docs: dict[str, tuple[str, Doc]]) -> None:
    network = _networks(docs)[0]
    network["scope"] = {**network["scope"], "sector": "private"}


def _index_row(docs: dict[str, tuple[str, Doc]]) -> Doc:
    code = _networks(docs)[0]["code"]
    return next(r for r in docs["health-services.json"][1]["networks"] if r["code"] == code)


@pytest.mark.parametrize(
    "mutate",
    [
        _break_index_count,
        _break_index_display_name,
        _break_index_states,
        _break_file_states,
        _break_scope,
    ],
)
def test_a_network_header_that_disagrees_with_its_index_or_members_fails(
    mutate: Callable[[dict[str, tuple[str, Doc]]], None],
) -> None:
    docs = _docs()
    mutate(docs)
    with pytest.raises(GateError, match="disagrees with the network index"):
        check_docs(ENTRIES, docs)
