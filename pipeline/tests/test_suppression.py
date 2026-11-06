import json
from collections import Counter
from dataclasses import replace
from pathlib import Path

import pytest

from surgerywaits.catalogue import Role
from surgerywaits.hospitals import load_register
from surgerywaits.suppression import (
    QLD_NULL_COLUMNS,
    QLD_VALUE_COLUMNS,
    Figure,
    FigureState,
    Reason,
    SuppressionError,
    figure_for_cell,
    qld_figures,
    suppress,
)
from surgerywaits.waiting_times import Cell, Table, build, load, read_rows

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "pipeline" / "tests" / "fixtures"
CACHE = ROOT / "pipeline" / ".downloads"
REGISTER_SLUGS = (
    "au-myhospitals-reporting-units",
    "au-myhospitals-reporting-unit-mappings",
    "au-hospitals-myhospitals",
)
SLUGS = {
    Table.URGENCY: "au-elective-surgery-waiting-times",
    Table.PROCEDURE: "au-elective-surgery-waiting-times-by-procedure",
    Table.SPECIALTY: "au-elective-surgery-waiting-times-by-specialty",
}


def _cell(value: float | None, marker: str | None, *, peer: bool = False) -> Cell:
    return Cell("surgeries", None if peer else Role.VOLUME, value, marker)


@pytest.mark.parametrize(
    ("marker", "reason", "text"),
    [
        ("<5", Reason.TOO_FEW_PATIENTS, "not published: too few patients"),
        ("-", Reason.NO_PATIENTS_REPORTED, "not published: no patients reported"),
        ("NP", Reason.NOT_PUBLISHED_BY_AIHW, "not published: not published by AIHW"),
    ],
)
def test_each_marker_gets_its_reason(marker: str, reason: Reason, text: str) -> None:
    figure = figure_for_cell(_cell(None, marker), "x")
    assert (figure.state, figure.reason, figure.value, figure.display) == (
        FigureState.NOT_PUBLISHED,
        reason,
        None,
        text,
    )
    assert not figure.rankable


def test_no_patients_reported_is_not_zero() -> None:
    dash = figure_for_cell(_cell(None, "-"), "x")
    zero = figure_for_cell(_cell(0, None), "x")
    assert dash.value is None
    assert zero.value == 0
    assert zero.state is FigureState.PUBLISHED
    assert dash.state is FigureState.NOT_PUBLISHED
    assert dash.reason is Reason.NO_PATIENTS_REPORTED
    assert dash != zero


def test_not_peered_shows_its_fixed_wording_in_peer_columns_only() -> None:
    figure = figure_for_cell(_cell(None, "Not peered", peer=True), "x")
    assert figure.display == "not published: no peer group comparison"
    with pytest.raises(SuppressionError, match="outside a peer-group column"):
        figure_for_cell(_cell(None, "Not peered"), "x")


def test_a_figure_cannot_hold_a_value_and_a_reason() -> None:
    with pytest.raises(SuppressionError):
        Figure("c", FigureState.NOT_PUBLISHED, 0, Reason.TOO_FEW_PATIENTS)
    with pytest.raises(SuppressionError):
        Figure("c", FigureState.PUBLISHED, None, None)


def test_a_published_cell_keeps_its_number() -> None:
    figure = figure_for_cell(_cell(12, None), "x")
    assert (figure.state, figure.value, figure.display) == (FigureState.PUBLISHED, 12, None)
    assert figure.rankable


def _qld_row(**changes: object) -> dict[str, object]:
    row: dict[str, object] = dict.fromkeys(QLD_VALUE_COLUMNS, 5)
    return {"facility_code": "191", "suppressed": [], **row, **changes}


def test_qld_flagged_columns_are_not_published_and_zero_stays_published() -> None:
    row = _qld_row(treated=0, percent_treated_in_time=None, suppressed=["percent_treated_in_time"])
    by_name = {f.column: f for f in qld_figures(row)}
    assert by_name["treated"].state is FigureState.PUBLISHED
    assert by_name["treated"].value == 0
    flagged = by_name["percent_treated_in_time"]
    assert flagged.reason is Reason.NOT_GIVEN_BY_QUEENSLAND_HEALTH
    assert flagged.display == "not published: Queensland Health gave no figure"


def test_qld_literal_null_is_not_reported_and_only_in_its_column() -> None:
    (column,) = QLD_NULL_COLUMNS
    figure = next(f for f in qld_figures(_qld_row(**{column: None})) if f.column == column)
    assert figure.state is FigureState.NOT_REPORTED
    assert figure.display == "not reported"
    with pytest.raises(SuppressionError, match="not flagged"):
        qld_figures(_qld_row(waiting=None))


def test_qld_rejects_a_flag_on_a_value_and_an_unknown_column() -> None:
    with pytest.raises(SuppressionError, match="with a value"):
        qld_figures(_qld_row(suppressed=["waiting"]))
    with pytest.raises(SuppressionError, match="not value columns"):
        qld_figures(_qld_row(suppressed=["nonsense"]))


def test_qld_fixtures_map_in_full() -> None:
    for slug in ("qld-elective-surgery-by-category", "qld-elective-surgery-by-specialty"):
        rows = read_rows(FIXTURES / slug / "data.parquet")
        counts = Counter(f.state for r in rows for f in qld_figures(r))
        assert counts[FigureState.NOT_PUBLISHED] == sum(len(r["suppressed"] or []) for r in rows)  # pyright: ignore[reportArgumentType]


def test_output_is_ordered_and_repeatable() -> None:
    rows = read_rows(FIXTURES / "au-elective-surgery-waiting-times" / "data.parquet")
    register = load_register(*(FIXTURES / s / "data.parquet" for s in REGISTER_SLUGS))
    result = build(rows, Table.URGENCY, register)
    first, second = suppress(result), suppress(replace(result))
    assert first == second
    assert next(k for k, _ in first.counts) == "published"


KEYS = (
    "published",
    Reason.TOO_FEW_PATIENTS,
    Reason.NO_PATIENTS_REPORTED,
    Reason.NOT_PUBLISHED_BY_AIHW,
    Reason.NO_PEER_GROUP_COMPARISON,
)


def _real(slug: str) -> Path:
    manifest = json.loads((ROOT / "data" / "manifest.json").read_text("utf-8"))
    return CACHE / next(d["sha256"] for d in manifest["datasets"] if d["slug"] == slug)


def test_the_pinned_releases_pass_suppression_in_full() -> None:
    if not all(_real(s).is_file() for s in (*REGISTER_SLUGS, *SLUGS.values())):
        pytest.skip("the pinned files are not cached")
    register = load_register(*(_real(s) for s in REGISTER_SLUGS))
    expected = {
        Table.URGENCY: (49891, 269, 736, 1004, 1200),
        Table.PROCEDURE: (405665, 43562, 31, 162690, 22607),
        Table.SPECIALTY: (71381, 1362, 12, 7127, 29248),
    }
    for table, slug in SLUGS.items():
        counts = dict(suppress(load(_real(slug), table, register)).counts)
        assert tuple(counts[k] for k in KEYS) == expected[table], table


def test_the_pinned_queensland_releases_map_in_full() -> None:
    slugs = ("qld-elective-surgery-by-category", "qld-elective-surgery-by-specialty")
    if not all(_real(s).is_file() for s in slugs):
        pytest.skip("the pinned files are not cached")
    expected = (
        {"published": 1762, "not_given_by_queensland_health": 38},
        {"published": 2634, "not_given_by_queensland_health": 90, "not_reported_by_source": 3},
    )
    for slug, want in zip(slugs, expected, strict=True):
        counts = Counter(
            f.reason.value if f.reason else "published"
            for r in read_rows(_real(slug))
            for f in qld_figures(r)
        )
        assert dict(counts) == want


@pytest.mark.parametrize("value", [True, float("nan"), float("inf"), "7"])
def test_a_published_value_must_be_a_finite_number(value: object) -> None:
    with pytest.raises(SuppressionError):
        Figure("c", FigureState.PUBLISHED, value, None)  # pyright: ignore[reportArgumentType]


@pytest.mark.parametrize(
    ("state", "reason"),
    [
        (FigureState.NOT_REPORTED, Reason.TOO_FEW_PATIENTS),
        (FigureState.NOT_REPORTED, Reason.NOT_GIVEN_BY_QUEENSLAND_HEALTH),
        (FigureState.NOT_PUBLISHED, Reason.NOT_REPORTED_BY_SOURCE),
        (FigureState.PUBLISHED, Reason.NO_PATIENTS_REPORTED),
    ],
)
def test_each_state_takes_only_its_own_reasons(state: FigureState, reason: Reason) -> None:
    with pytest.raises(SuppressionError):
        Figure("c", state, None, reason)


def test_qld_row_missing_a_column_fails_up_front() -> None:
    row = _qld_row()
    del row["waiting"]
    with pytest.raises(SuppressionError, match="lacks"):
        qld_figures(row)
