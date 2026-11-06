from functools import cache
from pathlib import Path

from surgerywaits.build import read_inputs
from surgerywaits.dist import Doc, Inputs, assemble
from surgerywaits.manifest import load

FIXTURES = Path(__file__).parent / "fixtures"


@cache
def fixture_inputs() -> Inputs:
    entries = load()
    return read_inputs(entries, {e.slug: FIXTURES / e.slug / "data.parquet" for e in entries})


@cache
def fixture_docs() -> dict[str, tuple[str, Doc]]:
    return assemble(fixture_inputs())
