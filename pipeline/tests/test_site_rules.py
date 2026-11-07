"""The site pins the pipeline's rules in one file, and this test holds the pin to the pipeline."""

import json
from pathlib import Path

from surgerywaits.catalogue import MAPPINGS
from surgerywaits.derive import LOWER_IS_BETTER
from surgerywaits.gates import MAX_PERIOD_AGE_YEARS, MAX_QLD_LAG_DAYS
from surgerywaits.nearby import NEIGHBOURS, START_RADIUS_KM
from surgerywaits.queensland import OVERRIDES
from surgerywaits.suppression import MARKER_REASONS

PIN = Path(__file__).resolve().parents[2] / "site" / "src" / "lib" / "pipeline-rules.json"


def _pin() -> dict[str, object]:
    return json.loads(PIN.read_text(encoding="utf8"))


def test_pin_matches_the_search_and_freshness_limits() -> None:
    pin = _pin()
    assert pin["neighbours"] == NEIGHBOURS
    assert pin["start_radius_km"] == START_RADIUS_KM
    assert pin["max_period_age_years"] == MAX_PERIOD_AGE_YEARS
    assert pin["max_qld_lag_days"] == MAX_QLD_LAG_DAYS
    assert pin["hand_matched_facilities"] == len(OVERRIDES)


def test_pin_matches_the_measures_the_pipeline_accepts() -> None:
    assert _pin()["measures"] == {m.role.value: m.name for m in MAPPINGS.values()}


def test_pin_matches_the_withheld_codes_and_the_rank_order() -> None:
    pin = _pin()
    assert pin["withheld_codes"] == {k: v.value for k, v in MARKER_REASONS.items()}
    assert pin["lower_is_better"] == {k.value: v for k, v in LOWER_IS_BETTER.items()}
