from collections import Counter
from dataclasses import replace
from importlib import import_module
from pathlib import Path
from typing import Any

import pytest

from realdata import pinned
from surgerywaits.catalogue import (
    MAPPINGS,
    Catalogue,
    CatalogueError,
    Role,
    Row,
    build,
    load,
    read_rows,
)

FIXTURE = (
    Path(__file__).resolve().parent
    / "fixtures"
    / "au-myhospitals-reported-measures"
    / "data.parquet"
)
CATCH_ALL = "ES_I888_OtherProcedure"
ROOT = Path(__file__).resolve().parents[2]
SLUG = "au-myhospitals-reported-measures"


def fixture_rows() -> list[Row]:
    return read_rows(FIXTURE)


def catch_all_rows(code: str = CATCH_ALL, name: str = "Other procedure") -> list[Row]:
    base = next(r for r in fixture_rows() if r["category_type_code"] == "ES_IP")
    return [
        {
            **base,
            "reported_measure_code": f"MYH-RM9{i}",
            "measure_code": m,
            "measure_name": MAPPINGS[m].name,
            "units": MAPPINGS[m].unit,
            "category_code": code,
            "category_name": name,
        }
        for i, m in enumerate(("MYH0009", "MYH0006", "MYH0007"))
    ]


def without_measure(rows: list[Row], code: str) -> list[Row]:
    return [r for r in rows if r["measure_code"] != code]


def test_the_fixture_publishes_all_four_mapped_measures() -> None:
    assert {r["measure_code"] for r in fixture_rows()} >= set(MAPPINGS)


def test_the_catalogue_maps_each_measure_to_its_role() -> None:
    catalogue = load(FIXTURE)
    assert {m.code: (m.role, m.unit) for m in catalogue.measures} == {
        "MYH0009": (Role.MEDIAN_WAIT, "days"),
        "MYH0006": (Role.VOLUME, "surgeries"),
        "MYH0007": (Role.LONG_WAIT, "percent"),
        "MYH0008": (Role.ON_TIME, "percent"),
    }


def test_each_category_carries_the_reported_measure_for_its_roles() -> None:
    by_code = {c.code: c for c in load(FIXTURE).categories}
    urgent = by_code["ES_U1_Urgent"]
    assert [p.role for p in urgent.reported] == [Role.MEDIAN_WAIT, Role.ON_TIME, Role.VOLUME]
    assert {p.role: p.code for p in urgent.reported}[Role.MEDIAN_WAIT] == "MYH-RM0040"
    cataract = by_code["ES_I001_CataractExtraction"]
    assert cataract.type_code == "ES_IP"
    assert [p.role for p in cataract.reported] == [Role.LONG_WAIT, Role.MEDIAN_WAIT, Role.VOLUME]


def test_measures_outside_the_four_mappings_stay_out() -> None:
    mapped = {r["reported_measure_code"] for r in fixture_rows() if r["measure_code"] in MAPPINGS}
    assert {p.code for c in load(FIXTURE).categories for p in c.reported} == mapped


def test_the_catalogue_is_the_same_whatever_the_row_order() -> None:
    rows = fixture_rows()
    assert build(rows) == build(list(reversed(rows)))


def test_a_missing_mapped_measure_fails() -> None:
    with pytest.raises(CatalogueError, match=r"MYH0008.*missing"):
        build(without_measure(fixture_rows(), "MYH0008"))


def test_a_changed_unit_fails() -> None:
    rows = [
        {**r, "units": "weeks"} if r["measure_code"] == "MYH0009" else r for r in fixture_rows()
    ]
    with pytest.raises(CatalogueError, match=r"MYH0009.*changed"):
        build(rows)


def test_a_changed_definition_fails() -> None:
    rows = [
        {**r, "measure_name": "Mean waiting time"} if r["measure_code"] == "MYH0006" else r
        for r in fixture_rows()
    ]
    with pytest.raises(CatalogueError, match=r"MYH0006.*changed"):
        build(rows)


def test_a_role_reported_twice_in_one_category_fails() -> None:
    rows = fixture_rows()
    dup = next(r for r in rows if r["category_code"] == "ES_U1_Urgent")
    with pytest.raises(CatalogueError, match="more than once"):
        build([*rows, {**dup, "reported_measure_code": "MYH-RM9999"}])


def test_a_missing_column_fails(tmp_path: Path) -> None:
    pq: Any = import_module("pyarrow")
    parquet: Any = import_module("pyarrow.parquet")
    parquet.write_table(pq.table({"measure_code": ["MYH0009"]}), tmp_path / "x.parquet")
    with pytest.raises(CatalogueError, match="lack columns"):
        read_rows(tmp_path / "x.parquet")


def test_a_null_value_fails(tmp_path: Path) -> None:
    pq: Any = import_module("pyarrow")
    parquet: Any = import_module("pyarrow.parquet")
    columns = {c: ["a"] for c in fixture_rows()[0]}
    columns["units"] = [None]  # pyright: ignore[reportArgumentType]
    parquet.write_table(pq.table(columns), tmp_path / "x.parquet")
    with pytest.raises(CatalogueError, match="no value"):
        read_rows(tmp_path / "x.parquet")


def test_the_catch_all_procedure_is_excluded_from_scope() -> None:
    catalogue: Catalogue = build([*fixture_rows(), *catch_all_rows()])
    assert CATCH_ALL not in {c.code for c in catalogue.categories}
    assert [c.code for c in catalogue.excluded] == [CATCH_ALL]
    assert replace(catalogue, excluded=()) == load(FIXTURE)


def test_a_catch_all_under_another_code_fails_closed() -> None:
    rows = [*fixture_rows(), *catch_all_rows("ES_I999_AllProcedures", "All procedures")]
    with pytest.raises(CatalogueError, match="catch-all"):
        build(rows)


@pytest.mark.parametrize(
    "name",
    [
        "Other (procedure)",
        "Other_procedure",
        "other procedures",
        "Other-procedure",
        "Procedures, other",
        "All procedures",
    ],
)
def test_catch_all_name_variants_fail_closed(name: str) -> None:
    with pytest.raises(CatalogueError, match="catch-all"):
        build([*fixture_rows(), *catch_all_rows("ES_I998_Variant", name)])


def test_a_catch_all_name_on_any_category_type_fails() -> None:
    rows = [
        {**r, "category_name": "All procedures"}
        if r["category_code"] == "ES_S1_CardioThoracicSurgery"
        else r
        for r in fixture_rows()
    ]
    with pytest.raises(CatalogueError, match="catch-all"):
        build(rows)


def test_other_surgery_specialty_stays_in_scope() -> None:
    assert "ES_S11_OtherSurgery" in {c.code for c in load(FIXTURE).categories}


def test_one_category_code_with_two_names_fails() -> None:
    rows = fixture_rows()
    rows = [{**r, "category_name": "Renamed"} if r is rows[0] else r for r in rows]
    with pytest.raises(CatalogueError, match="more than one way"):
        build(rows)


def test_one_category_code_with_two_types_fails() -> None:
    rows = fixture_rows()
    rows = [{**r, "category_type_code": "ES_SS"} if r is rows[0] else r for r in rows]
    with pytest.raises(CatalogueError, match="more than one way"):
        build(rows)


def test_an_unknown_category_type_fails() -> None:
    rows = [
        {**r, "category_type_code": "NEW"} if r["category_code"] == "ES_U1_Urgent" else r
        for r in fixture_rows()
    ]
    with pytest.raises(CatalogueError, match="unknown type"):
        build(rows)


def test_a_role_outside_the_type_fails() -> None:
    rows = fixture_rows()
    on_time = next(r for r in rows if r["measure_code"] == "MYH0008")
    ip = next(r for r in rows if r["category_type_code"] == "ES_IP")
    stray = {
        **on_time,
        "reported_measure_code": "MYH-RM9998",
        "category_code": ip["category_code"],
        "category_name": ip["category_name"],
        "category_type_code": "ES_IP",
        "category_type_name": ip["category_type_name"],
    }
    with pytest.raises(CatalogueError, match="outside its type"):
        build([*rows, stray])


def test_a_blank_required_value_fails(tmp_path: Path) -> None:
    pq: Any = import_module("pyarrow")
    parquet: Any = import_module("pyarrow.parquet")
    columns = {c: ["a"] for c in fixture_rows()[0]}
    columns["units"] = ["  "]
    parquet.write_table(pq.table(columns), tmp_path / "x.parquet")
    with pytest.raises(CatalogueError, match="no value"):
        read_rows(tmp_path / "x.parquet")


def test_a_category_missing_a_role_of_its_type_fails() -> None:
    rows = [
        r
        for r in fixture_rows()
        if not (r["category_code"] == "ES_U1_Urgent" and r["measure_code"] == "MYH0008")
    ]
    with pytest.raises(CatalogueError, match=r"lacks \['on_time'\]"):
        build(rows)


def test_padded_values_agree_with_clean_ones() -> None:
    rows = fixture_rows()
    padded = [{k: f"  {v}\t" for k, v in r.items()} if i % 2 else r for i, r in enumerate(rows)]
    stripped = [{k: v.strip() for k, v in r.items()} for r in padded]
    assert build(stripped) == build(rows)


def test_padded_values_in_a_file_are_stored_stripped(tmp_path: Path) -> None:
    pq: Any = import_module("pyarrow")
    parquet: Any = import_module("pyarrow.parquet")
    rows = fixture_rows()[:1]
    parquet.write_table(
        pq.table({k: [f" {v} "] for k, v in rows[0].items()}), tmp_path / "x.parquet"
    )
    assert read_rows(tmp_path / "x.parquet") == rows


def test_the_pinned_release_has_the_expected_scope() -> None:
    (path,) = pinned(SLUG)
    catalogue = load(path)
    counts = Counter(c.type_code for c in catalogue.categories)
    assert counts == {"ES_IP": 151, "ES_SS": 12, "ES_URGENCY": 3}
    assert [c.code for c in catalogue.excluded] == [CATCH_ALL]
    assert "ES_S11_OtherSurgery" in {c.code for c in catalogue.categories}
