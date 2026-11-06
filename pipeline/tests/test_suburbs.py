import struct
from collections.abc import Sequence
from pathlib import Path
from typing import cast

import pytest

from realdata import pinned
from surgerywaits.suburbs import (
    Row,
    SuburbError,
    build_suburbs,
    centre_of,
    centroid,
    contains,
    is_special_purpose,
    parse_polygons,
    read_suburbs,
    shape_rows,
)

FIXTURE = (
    Path(__file__).resolve().parent / "fixtures" / "abs-suburbs-localities-2021" / "data.parquet"
)
# Shapes sit at this offset so every centre is inside Australia's bounds.
ORIGIN = (140.0, -40.0)

Ring = Sequence[tuple[float, float]]


def _ring(points: Ring, order: str = "<") -> bytes:
    flat = [v for x, y in [*points, points[0]] for v in (ORIGIN[0] + x, ORIGIN[1] + y)]
    return struct.pack(f"{order}I{len(flat)}d", len(points) + 1, *flat)


def _polygon(rings: Sequence[Ring], order: str = "<") -> bytes:
    head = struct.pack(f"{order}BII", 1 if order == "<" else 0, 3, len(rings))
    return head + b"".join(_ring(r, order) for r in rings)


def _multi(polygons: Sequence[Sequence[Ring]], outer: str = "<", inner: str = "<") -> bytes:
    head = struct.pack(f"{outer}BII", 1 if outer == "<" else 0, 6, len(polygons))
    return head + b"".join(_polygon(p, inner) for p in polygons)


def _square(x: float, y: float, side: float) -> Ring:
    return [(x, y), (x + side, y), (x + side, y + side), (x, y + side)]


def _row(code: str, name: str, geometry: object, state: str = "New South Wales") -> Row:
    return {
        "sal_2021_code": code,
        "sal_2021_name": name,
        "state_name": state,
        "geometry": geometry,
    }


def test_centroid_of_a_concave_shape_is_its_area_centroid() -> None:
    l_shape = [(0, 0), (4, 0), (4, 2), (2, 2), (2, 4), (0, 4)]
    assert centre_of(_polygon([l_shape])) == (-38.33333, 141.66667)


def test_ring_direction_does_not_change_the_centre() -> None:
    l_shape = [(0, 0), (4, 0), (4, 2), (2, 2), (2, 4), (0, 4)]
    assert centre_of(_polygon([l_shape[::-1]])) == centre_of(_polygon([l_shape]))


def test_a_hole_counts_as_negative_area() -> None:
    assert centre_of(_polygon([_square(0, 0, 4), _square(0, 0, 2)])) == (-37.66667, 142.33333)


def test_a_multipolygon_weights_each_part_by_area() -> None:
    parts = [[_square(0, 0, 1)], [_square(10, 0, 3)]]
    assert centre_of(_multi(parts)) == (-38.6, 150.4)


def test_big_endian_shapes_are_read() -> None:
    assert centre_of(_polygon([_square(0, 0, 2)], "<")) == centre_of(
        _polygon([_square(0, 0, 2)], ">")
    )


def test_a_multipolygon_reads_the_same_in_any_byte_order() -> None:
    parts = [[_square(0, 0, 1)], [_square(10, 0, 3)]]
    expected = centre_of(_multi(parts))
    assert centre_of(_multi(parts, ">", ">")) == expected
    assert centre_of(_multi(parts, "<", ">")) == expected
    assert centre_of(_multi(parts, ">", "<")) == expected


def test_a_shape_with_a_z_flag_is_rejected() -> None:
    iso = struct.pack("<BII", 1, 1003, 0)
    ewkb = struct.pack("<BII", 1, 0x80000003, 0)
    for wkb in (iso, ewkb):
        with pytest.raises(SuburbError, match="not a polygon"):
            centre_of(wkb)


def test_a_centre_is_rounded_to_five_places() -> None:
    lat, lon = centre_of(_polygon([[(0, 0), (1, 0), (0.123456789, 1)]]))
    assert (lat, lon) == (-39.66667, 140.37449)


@pytest.mark.parametrize(
    ("wkb", "message"),
    [
        (struct.pack("<BIdd", 1, 1, 140.0, -30.0), "not a polygon"),
        (_polygon([_square(0, 0, 1)])[:-3], "ends early"),
        (_polygon([_square(0, 0, 1)]) + b"\x00", "trailing"),
        (_polygon([[(0, 0), (1, 1), (2, 2)]]), "no area"),
        (struct.pack("<BII", 7, 3, 0), "byte order"),
        (_polygon([]), "no area"),
    ],
)
def test_a_shape_that_is_not_a_usable_polygon_fails(wkb: bytes, message: str) -> None:
    with pytest.raises(SuburbError, match=message):
        centre_of(wkb)


def test_an_unclosed_ring_fails() -> None:
    wkb = struct.pack("<BIII8d", 1, 3, 1, 4, 140, -40, 141, -40, 141, -39, 140, -39)
    with pytest.raises(SuburbError, match="not closed"):
        centre_of(wkb)


def test_a_centroid_outside_a_crescent_gives_a_point_inside_it() -> None:
    crescent = [(0, 0), (10, 0), (10, 1), (1, 1), (1, 10), (0, 10)]
    shape = parse_polygons(_polygon([crescent]))
    assert not contains(shape, centroid(shape))
    lat, lon = centre_of(_polygon([crescent]))
    assert contains(shape, (lon, lat))


def test_the_pole_of_a_multipart_shape_lies_in_its_largest_part() -> None:
    ring = [(0, 0), (10, 0), (10, 1), (1, 1), (1, 10), (0, 10)]
    parts = [[_square(20, 20, 0.5)], [ring]]
    lat, lon = centre_of(_multi(parts))
    assert contains(parse_polygons(_multi(parts)), (lon, lat))
    assert lon < ORIGIN[0] + 10


def test_a_centroid_in_a_hole_is_outside() -> None:
    shape = parse_polygons(_polygon([_square(0, 0, 6), _square(1, 1, 4)]))
    assert not contains(shape, centroid(shape))
    lat, lon = centre_of(_polygon([_square(0, 0, 6), _square(1, 1, 4)]))
    assert contains(shape, (lon, lat))


def test_a_centre_outside_australia_fails() -> None:
    far = struct.pack("<BIII8d", 1, 3, 1, 4, 0, 0, 1, 0, 0, 1, 0, 0)
    with pytest.raises(SuburbError, match="outside Australia"):
        centre_of(far)


def test_special_purpose_codes_are_excluded() -> None:
    rows = [
        _row("10003", "Abbotsford (NSW)", _polygon([_square(0, 0, 1)])),
        _row("19494", "No usual address (NSW)", None),
        _row("99797", "Migratory - Offshore - Shipping (OT)", None, "Other Territories"),
        _row("ZZZZZ", "Outside Australia", None, "Outside Australia"),
    ]
    result = build_suburbs(rows)
    assert [s.code for s in result.suburbs] == ["10003"]
    assert result.excluded == ("19494", "99797", "ZZZZZ")
    assert not is_special_purpose("10003")
    assert not is_special_purpose("94940")


def test_a_row_without_a_shape_fails() -> None:
    with pytest.raises(SuburbError, match=r"10003: Abbotsford \(NSW\) has no shape"):
        build_suburbs([_row("10003", "Abbotsford (NSW)", None)])


def test_a_name_shared_within_a_state_fails() -> None:
    shape = _polygon([_square(0, 0, 1)])
    rows = [_row("10001", "Same", shape), _row("10002", "Same", shape)]
    with pytest.raises(SuburbError, match="shared within a state: New South Wales: Same"):
        build_suburbs(rows)


def test_a_name_shared_across_states_is_kept_as_the_abs_qualified_it() -> None:
    shape = _polygon([_square(0, 0, 1)])
    rows = [
        _row("20002", "Abbotsford (Vic.)", shape, "Victoria"),
        _row("10003", "Abbotsford (NSW)", shape),
    ]
    assert [s.name for s in build_suburbs(rows).suburbs] == [
        "Abbotsford (NSW)",
        "Abbotsford (Vic.)",
    ]


def test_a_code_that_appears_twice_fails() -> None:
    shape = _polygon([_square(0, 0, 1)])
    with pytest.raises(SuburbError, match="appears twice"):
        build_suburbs([_row("10001", "A", shape), _row("10001", "B", shape)])


def test_a_row_without_a_name_fails() -> None:
    with pytest.raises(SuburbError, match="sal_2021_name is missing"):
        build_suburbs([_row("10001", " ", _polygon([_square(0, 0, 1)]))])


def test_a_missing_file_fails() -> None:
    with pytest.raises(SuburbError, match="cannot read"):
        read_suburbs(Path("no-such-file.parquet"))


def test_the_fixture_extract_gives_known_centres() -> None:
    result = read_suburbs(FIXTURE)
    by_name = {s.name: s for s in result.suburbs}
    assert len(result.suburbs) == 13  # noqa: PLR2004
    assert result.excluded == ("19494", "19797", "ZZZZZ")
    wollongong = by_name["Wollongong"]
    assert (wollongong.latitude, wollongong.longitude) == (-34.42758, 150.89308)
    assert by_name["Abbotsford (Vic.)"].state == "Victoria"


def test_fixture_suburbs_whose_centroid_is_outside_get_a_point_inside() -> None:
    shapes = {
        r["sal_2021_code"]: parse_polygons(cast("bytes", r["geometry"]))
        for r in shape_rows(FIXTURE)
        if r["geometry"] is not None
    }
    by_code = {s.code: s for s in read_suburbs(FIXTURE).suburbs}
    for code in ("60007", "60071", "60380"):
        assert not contains(shapes[code], centroid(shapes[code]))
        assert contains(shapes[code], (by_code[code].longitude, by_code[code].latitude))
    assert len(shapes["60007"]) == 2  # noqa: PLR2004
    for code, suburb in by_code.items():
        assert contains(shapes[code], (suburb.longitude, suburb.latitude))


def test_reading_twice_gives_the_same_suburbs() -> None:
    assert read_suburbs(FIXTURE) == read_suburbs(FIXTURE)


def test_pinned_boundary_file_gives_every_suburb_a_centre() -> None:
    (path,) = pinned("abs-suburbs-localities-2021")
    result = read_suburbs(path)
    by_name = {s.name: s for s in result.suburbs}
    by_code = {s.code: s for s in result.suburbs}
    assert len(result.suburbs) == 15334  # noqa: PLR2004
    assert len(result.excluded) == 19  # noqa: PLR2004
    assert result.excluded[-1] == "ZZZZZ"
    assert [s.code for s in result.suburbs] == sorted(s.code for s in result.suburbs)
    assert len({(s.state, s.name) for s in result.suburbs}) == len(result.suburbs)
    plain = 0
    for row in shape_rows(path):
        geometry = row["geometry"]
        if not isinstance(geometry, bytes):
            continue
        shape = parse_polygons(geometry)
        suburb = by_code[cast("str", row["sal_2021_code"])]
        assert contains(shape, (suburb.longitude, suburb.latitude))
        lon, lat = centroid(shape)
        plain += (suburb.latitude, suburb.longitude) == (round(lat, 5), round(lon, 5))
    assert plain == 15173  # noqa: PLR2004
    sydney = by_name["Sydney"]
    assert (sydney.latitude, sydney.longitude) == pytest.approx((-33.8688, 151.2093), abs=0.01)
    hobart = by_name["Hobart"]
    assert (hobart.latitude, hobart.longitude) == pytest.approx((-42.8826, 147.3257), abs=0.02)
    assert by_name["Abbotsford (Vic.)"].state == "Victoria"
