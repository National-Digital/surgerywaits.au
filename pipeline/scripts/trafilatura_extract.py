"""Prints trafilatura's main text for each HTML file named on stdin, as JSON keyed by path."""

import json
import sys
from pathlib import Path

import trafilatura


def main() -> None:
    paths: list[str] = json.load(sys.stdin)
    out: dict[str, str] = {}
    for p in paths:
        html = Path(p).read_text(encoding="utf-8")
        out[p] = (
            trafilatura.extract(
                html, output_format="txt", include_comments=False, include_tables=True
            )
            or ""
        )
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
