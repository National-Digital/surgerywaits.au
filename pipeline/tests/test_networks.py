import copy
from typing import Any

import pytest

from fixture_dist import fixture_docs
from surgerywaits.contract import ContractError, validate
from surgerywaits.dist import DistError, Doc, network_slugs
from surgerywaits.gates import URGENT_SLUG, GateError, check_docs
from surgerywaits.hospitals import Hospital
from surgerywaits.manifest import load
from test_dist import real_docs

ENTRIES = load()

# The addresses the live site already serves, so a rename here is a broken link there.
LIVE_SLUGS = (
    "albury-wodonga-health",
    "alfred-health",
    "austin-health",
    "australian-capital-territory",
    "barossa-hills-fleurieu",
    "barwon-health",
    "bass-coast-regional-health",
    "bendigo-health-care-group",
    "cairns-and-hinterland",
    "central-adelaide",
    "central-coast",
    "central-queensland",
    "central-west",
    "child-adolescent-health-service",
    "childrens-health-queensland",
    "darling-downs",
    "east-metropolitan-health-service",
    "eastern-health",
    "eyre-and-far-north",
    "far-west",
    "flinders-and-upper-north",
    "gold-coast",
    "goulburn-valley-health",
    "grampians-health",
    "hunter-new-england",
    "illawarra-shoalhaven",
    "latrobe-regional-hospital",
    "limestone-coast",
    "mackay",
    "melbourne-health",
    "mercy-public-hospital-inc",
    "metro-north",
    "metro-south",
    "mid-north-coast",
    "monash-health",
    "murrumbidgee",
    "nepean-blue-mountains",
    "north-metropolitan-health-service",
    "north-west",
    "northeast-health-wangaratta",
    "northern-adelaide",
    "northern-health",
    "northern-nsw",
    "northern-sydney",
    "nt-regional-health-services",
    "peninsula-health",
    "peter-maccallum-cancer-institute",
    "riverland-mallee-coorong",
    "royal-childrens-hospital",
    "royal-victorian-eye-and-ear-hospital",
    "royal-womens-hospital",
    "south-eastern-sydney",
    "south-metropolitan-health-service",
    "south-west",
    "south-west-healthcare",
    "south-western-sydney",
    "southern-adelaide",
    "southern-nsw",
    "st-vincents-health-network",
    "st-vincents-hospital-melbourne-limited",
    "sunshine-coast",
    "sydney",
    "sydney-childrens-hospitals-network",
    "tasmanian-health-service",
    "torres-and-cape",
    "townsville",
    "wa-country-health-service",
    "west-gippsland-healthcare-group",
    "west-moreton",
    "western-health",
    "western-nsw",
    "western-sydney",
    "wide-bay",
    "womens-and-childrens-health-network",
    "yorke-and-northern",
)


def _hospital(code: str, network_code: str | None, network_name: str | None) -> Hospital:
    return Hospital(
        code=code,
        name=f"Hospital {code}",
        alternative_names=(),
        state="Vic",
        latitude=None,
        longitude=None,
        closed=False,
        network_code=network_code,
        network_name=network_name,
        network_status="mapped" if network_code else "unmapped",
    )


def _docs() -> dict[str, tuple[str, Doc]]:
    return copy.deepcopy(fixture_docs())


def _network_path(docs: dict[str, tuple[str, Doc]]) -> str:
    return next(p for p, (k, _) in sorted(docs.items()) if k == "health-service")


def test_a_trailing_state_qualifier_is_dropped_from_the_slug() -> None:
    found = network_slugs([_hospital("H1", "N1", "Eastern Health (Vic)")])
    assert found == {"N1": "eastern-health"}


def test_networks_whose_short_names_collide_fall_back_to_the_full_name_then_the_code() -> None:
    found = network_slugs(
        [
            _hospital("H1", "N1", "Alpha (Vic)"),
            _hospital("H2", "N2", "Alpha (Qld)"),
            _hospital("H3", "N3", "Beta (X)"),
            _hospital("H4", "N4", "Beta (X)"),
        ]
    )
    assert found == {"N1": "alpha-vic", "N2": "alpha-qld", "N3": "beta-x-n3", "N4": "beta-x-n4"}


def test_network_slugs_do_not_depend_on_hospital_order() -> None:
    hospitals = [_hospital("H1", "N1", "Alpha (Vic)"), _hospital("H2", "N2", "Alpha (Qld)")]
    assert network_slugs(hospitals) == network_slugs(hospitals[::-1])


def test_a_full_name_that_equals_another_networks_short_name_fails() -> None:
    hospitals = [
        _hospital("H1", "N1", "Alpha (Vic)"),
        _hospital("H2", "N2", "Alpha (Qld)"),
        _hospital("H3", "N3", "Alpha Vic"),
    ]
    with pytest.raises(DistError, match=r"network slugs are not unique"):
        network_slugs(hospitals)


def test_a_network_without_hospitals_that_have_pages_has_no_slug() -> None:
    assert network_slugs([_hospital("H1", None, None)]) == {}


def test_the_fixture_networks_validate_and_list_real_hospital_files() -> None:
    docs = fixture_docs()
    networks = [(p, d) for p, (k, d) in docs.items() if k == "health-service"]
    assert networks
    for path, d in networks:
        assert path == f"health-services/{d['slug']}.json"
        assert d["hospitals"]
        for member in d["hospitals"]:
            hospital = docs[f"hospitals/{member['slug']}.json"][1]
            assert hospital["network"] == {"code": d["code"], "name": d["name"], "slug": d["slug"]}
            assert hospital["state"] in d["states"]


def test_a_network_file_rejects_an_unknown_field_and_a_missing_slug() -> None:
    page = _docs()[_network_path(_docs())][1]
    validate("health-service", page)
    with pytest.raises(ContractError):
        validate("health-service", {**page, "extra": 1})
    del page["slug"]
    with pytest.raises(ContractError, match="slug"):
        validate("health-service", page)


def test_two_networks_sharing_a_slug_fail_the_gate() -> None:
    docs = _docs()
    paths = [p for p, (k, _) in sorted(docs.items()) if k == "health-service"]
    docs[paths[1]][1]["slug"] = docs[paths[0]][1]["slug"]
    with pytest.raises(GateError, match=r"network slug .* used twice"):
        check_docs(ENTRIES, docs)


def test_a_network_slug_that_is_not_url_safe_fails_the_gate() -> None:
    docs = _docs()
    docs[_network_path(docs)][1]["slug"] = "Not_Safe"
    with pytest.raises(GateError, match=r"network slug .* not URL-safe"):
        check_docs(ENTRIES, docs)


def test_a_hospital_that_names_a_different_network_slug_fails_the_gate() -> None:
    docs = _docs()
    hospital = next(d for _, (k, d) in sorted(docs.items()) if k == "hospital" and d["network"])
    hospital["network"]["slug"] = "somewhere-else"
    with pytest.raises(GateError, match="list different slugs"):
        check_docs(ENTRIES, docs)


def test_an_index_that_disagrees_with_the_network_files_fails_the_gate() -> None:
    docs = _docs()
    docs["health-services.json"][1]["networks"].pop()
    with pytest.raises(GateError, match="list different slugs"):
        check_docs(ENTRIES, docs)


def test_a_network_that_drops_a_member_fails_the_gate() -> None:
    docs = _docs()
    docs[_network_path(docs)][1]["hospitals"].pop()
    with pytest.raises(GateError, match="member hospitals"):
        check_docs(ENTRIES, docs)


def test_the_real_dist_serves_exactly_the_addresses_the_live_site_does() -> None:
    docs: dict[str, Any] = real_docs()
    found = sorted(
        p.removeprefix("health-services/").removesuffix(".json")
        for p in docs
        if p.startswith("health-services/")
    )
    assert found == sorted(LIVE_SLUGS)
    assert [n["slug"] for n in docs["health-services.json"]["networks"]] == sorted(LIVE_SLUGS)


def test_every_real_mapped_hospital_is_a_member_of_exactly_one_network() -> None:
    docs: dict[str, Any] = real_docs()
    mapped = {r["slug"] for r in docs["hospitals.json"]["hospitals"] if r["network"]}
    members = [
        h["slug"]
        for p, d in docs.items()
        if p.startswith("health-services/")
        for h in d["hospitals"]
    ]
    assert len(members) == len(set(members))
    assert set(members) == mapped
    assert 0 < len(mapped) < len(docs["hospitals.json"]["hospitals"])


def test_the_real_networks_count_the_published_urgent_figures_the_hospital_files_hold() -> None:
    docs: dict[str, Any] = real_docs()
    members = [
        h for p, d in docs.items() if p.startswith("health-services/") for h in d["hospitals"]
    ]
    hospitals = {
        d["slug"]: d for p, d in docs.items() if p.startswith("hospitals/") and d["network"]
    }
    expected = 0
    for m in members:
        surgeries = hospitals[m["slug"]]["surgeries"]
        urgent = next((s for s in surgeries if s["slug"] == URGENT_SLUG), None)
        on_time = urgent["measures"].get("on_time") if urgent and not urgent["stale"] else None
        expected += on_time is not None and on_time["figure"]["state"] == "published"
    found = sum(1 for h in members if h["urgent_on_time"]["status"] == "published")
    assert found == expected
    assert 0 < found < len(members)
