from typing import Any

from surgerywaits.catalogue import LONG_WAIT_DAYS, MAPPINGS
from surgerywaits.derive import LOWER_IS_BETTER
from surgerywaits.gates import MAX_PERIOD_AGE_YEARS, MAX_QLD_LAG_DAYS
from surgerywaits.nearby import NEIGHBOURS, START_RADIUS_KM
from surgerywaits.queensland import OVERRIDES
from surgerywaits.suppression import MARKER_REASONS


def rules_doc() -> dict[str, Any]:
    """The limits and names the pipeline applies, for the site copy that states them."""
    return {
        "neighbours": NEIGHBOURS,
        "start_radius_km": START_RADIUS_KM,
        "max_period_age_years": MAX_PERIOD_AGE_YEARS,
        "max_qld_lag_days": MAX_QLD_LAG_DAYS,
        "long_wait_days": LONG_WAIT_DAYS,
        "hand_matched_facilities": len(OVERRIDES),
        "measures": {m.role.value: m.name for m in MAPPINGS.values()},
        "withheld_codes": {marker: reason.value for marker, reason in MARKER_REASONS.items()},
        "lower_is_better": {role.value: lower for role, lower in LOWER_IS_BETTER.items()},
    }
