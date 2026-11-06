import argparse
import sys
from functools import cache
from pathlib import Path

from surgerywaits.build import read_inputs
from surgerywaits.dist import Doc, Inputs, assemble, build_dist
from surgerywaits.manifest import load

FIXTURES = Path(__file__).parent / "fixtures"


@cache
def fixture_inputs() -> Inputs:
    entries = load()
    return read_inputs(entries, {e.slug: FIXTURES / e.slug / "data.parquet" for e in entries})


@cache
def fixture_docs() -> dict[str, tuple[str, Doc]]:
    return assemble(fixture_inputs())


def main(argv: list[str] | None = None) -> int:
    """Write the fixture dist for the site's checks; two runs give identical bytes."""
    parser = argparse.ArgumentParser(description="Build a small dist from the pipeline fixtures.")
    parser.add_argument("out", type=Path)
    built = build_dist(fixture_inputs(), parser.parse_args(argv).out)
    sys.stdout.write(f"{len(built)} files\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
