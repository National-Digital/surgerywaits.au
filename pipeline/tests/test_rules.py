"""The rules file in the dist holds the live constants, so the site copy cannot drift from them."""

import json

from fixture_dist import fixture_docs
from surgerywaits.catalogue import LONG_WAIT_DAYS, MAPPINGS
from surgerywaits.derive import LOWER_IS_BETTER
from surgerywaits.dist import render
from surgerywaits.gates import MAX_PERIOD_AGE_YEARS, MAX_QLD_LAG_DAYS
from surgerywaits.nearby import NEIGHBOURS, START_RADIUS_KM
from surgerywaits.queensland import OVERRIDES
from surgerywaits.suppression import MARKER_REASONS


def _emitted() -> dict[str, object]:
    return json.loads(render(fixture_docs())["rules.json"])


def test_the_emitted_rules_equal_the_live_constants() -> None:
    assert _emitted() == {
        "neighbours": NEIGHBOURS,
        "start_radius_km": START_RADIUS_KM,
        "max_period_age_years": MAX_PERIOD_AGE_YEARS,
        "max_qld_lag_days": MAX_QLD_LAG_DAYS,
        "long_wait_days": LONG_WAIT_DAYS,
        "hand_matched_facilities": len(OVERRIDES),
        "measures": {m.role.value: m.name for m in MAPPINGS.values()},
        "withheld_codes": {k: v.value for k, v in MARKER_REASONS.items()},
        "lower_is_better": {k.value: v for k, v in LOWER_IS_BETTER.items()},
    }
