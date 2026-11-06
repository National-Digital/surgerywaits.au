import argparse
import sys
import time
from collections.abc import Mapping
from pathlib import Path

from surgerywaits.catalogue import load as load_catalogue
from surgerywaits.derive import derive
from surgerywaits.dist import DistError, Inputs, build_dist
from surgerywaits.gates import GateError
from surgerywaits.hospitals import load_register
from surgerywaits.manifest import MANIFEST_PATH, Entry, ManifestError, load
from surgerywaits.pull import CACHE_DIR, PullError, pull
from surgerywaits.queensland import load_overlay
from surgerywaits.suburbs import read_suburbs
from surgerywaits.suppression import suppress
from surgerywaits.waiting_times import Table
from surgerywaits.waiting_times import load as load_waiting_times

DEFAULT_OUT = Path(__file__).resolve().parents[2] / "dist"
TABLE_SLUGS = {
    Table.URGENCY: "au-elective-surgery-waiting-times",
    Table.PROCEDURE: "au-elective-surgery-waiting-times-by-procedure",
    Table.SPECIALTY: "au-elective-surgery-waiting-times-by-specialty",
}


def read_inputs(entries: tuple[Entry, ...], files: Mapping[str, Path]) -> Inputs:
    """Run every stage from the verified source files to the inputs the dist writer needs."""
    register = load_register(
        files["au-myhospitals-reporting-units"],
        files["au-myhospitals-reporting-unit-mappings"],
        files["au-hospitals-myhospitals"],
    )
    tables = {
        t: suppress(load_waiting_times(files[slug], t, register)) for t, slug in TABLE_SLUGS.items()
    }
    return Inputs(
        entries=entries,
        register=register,
        catalogue=load_catalogue(files["au-myhospitals-reported-measures"]),
        tables=tables,
        derived=derive(tables, register),
        suburbs=read_suburbs(files["abs-suburbs-localities-2021"]),
        overlay=load_overlay(
            files["qld-elective-surgery-by-category"],
            files["qld-elective-surgery-by-specialty"],
            register,
        ),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the dist from the pinned source files.")
    parser.add_argument("--manifest", type=Path, default=MANIFEST_PATH)
    parser.add_argument("--cache", type=Path, default=CACHE_DIR)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)
    started = time.monotonic()
    try:
        entries = load(args.manifest)
        files = pull(entries, args.cache)
        built = build_dist(read_inputs(entries, files), args.out)
    except (ManifestError, PullError, DistError, GateError) as err:
        sys.stderr.write(f"build failed: {err}\n")
        return 1
    total = sum(len(b) for b in built.values())
    sys.stdout.write(f"{len(built)} files, {total} bytes, {time.monotonic() - started:.0f}s\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
