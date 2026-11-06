import os
from pathlib import Path

import pytest

from surgerywaits.manifest import load
from surgerywaits.pull import CACHE_DIR

REQUIRE_ENV = "SURGERYWAITS_REQUIRE_DATA"


def pinned(*slugs: str) -> list[Path]:
    """Cached paths of the pinned files; a missing one skips, or fails when data is required."""
    entries = {e.slug: e for e in load()}
    paths = [CACHE_DIR / entries[s].sha256 for s in slugs]
    missing = [s for s, p in zip(slugs, paths, strict=True) if not p.is_file()]
    if missing:
        message = f"pinned files not in the pipeline cache: {', '.join(missing)}"
        if os.environ.get(REQUIRE_ENV) == "1":
            pytest.fail(message, pytrace=False)
        pytest.skip(message)
    return paths
