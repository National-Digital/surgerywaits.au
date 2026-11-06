"""One centre point for each ABS suburb or locality, computed from the pinned boundary file.

Method (decision D29): the area centroid of the suburb's shape when it lies inside the shape, and
otherwise the pole of inaccessibility of the shape's largest part. The shape is the WKB polygon or
multipolygon in the file's `geometry` column, in GDA2020 longitude and latitude. Each ring's
centroid and signed area come from the shoelace formula on planar degrees, taken about the ring's
first vertex. A multipolygon's centroid is the mean of its rings' area-weighted centroids, and a
hole counts as negative area. "Inside" is an even-odd test over every ring of every part, so
holes and gaps between parts are outside. The pole is the point inside the part farthest from its
edges, found by the polylabel cell search to 1e-5 degrees with a fixed visiting order, so it is
deterministic. The result is rounded to 5 decimal places, about a metre. Planar degrees are not an
equal-area plane, so a very large locality's centre sits slightly off its true centroid; every
distance from a centre is labelled approximate.

Special-purpose codes have no shape and are not places. They are excluded and listed in
`SPECIAL_PURPOSE_SUFFIXES` and `OUTSIDE_AUSTRALIA`. Any other row without a usable shape fails.

Names are used as the ABS publishes them. The ABS already qualifies a name that more than one
state or territory shares, such as "Abbotsford (NSW)" and "Abbotsford (Vic.)". A name shared twice
within one state would be ambiguous, so it fails.
"""

import heapq
import struct
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from importlib import import_module
from itertools import count, pairwise
from math import hypot, sqrt
from pathlib import Path
from typing import Any, cast

# pyarrow ships no type stubs, so it is loaded dynamically and read only through read_suburbs.
PQ: Any = import_module("pyarrow.parquet")

Row = Mapping[str, object]
Point = tuple[float, float]
Ring = tuple[Point, ...]
Polygon = tuple[Ring, ...]

DECIMAL_PLACES = 5
POLE_PRECISION = 1e-5
BATCH_ROWS = 256

# The ABS gives each state a "no usual address" code ending 9494 and a "migratory, offshore and
# shipping" code ending 9797, and gives the rest of the world one code.
SPECIAL_PURPOSE_SUFFIXES = ("9494", "9797")
OUTSIDE_AUSTRALIA = "ZZZZZ"

# Longitude and latitude bounds that cover the mainland, Tasmania and every external territory.
LONGITUDE_RANGE = (90.0, 175.0)
LATITUDE_RANGE = (-62.0, -8.0)

WKB_POLYGON = 3
WKB_MULTIPOLYGON = 6
WKB_HEADER = 5
WKB_POINT_BYTES = 16
LITTLE_ENDIAN = 1
BIG_ENDIAN = 0


class SuburbError(Exception):
    pass


@dataclass(frozen=True)
class Suburb:
    code: str
    name: str
    state: str
    latitude: float
    longitude: float


@dataclass(frozen=True)
class Suburbs:
    suburbs: tuple[Suburb, ...]
    excluded: tuple[str, ...]


def is_special_purpose(code: str) -> bool:
    return code == OUTSIDE_AUSTRALIA or code.endswith(SPECIAL_PURPOSE_SUFFIXES)


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.at = 0

    def take(self, size: int) -> bytes:
        end = self.at + size
        if end > len(self.data):
            msg = "geometry ends early"
            raise SuburbError(msg)
        chunk = self.data[self.at : end]
        self.at = end
        return chunk

    def header(self) -> tuple[str, int]:
        order = self.take(1)[0]
        if order not in (LITTLE_ENDIAN, BIG_ENDIAN):
            msg = f"geometry has byte order {order}"
            raise SuburbError(msg)
        prefix = "<" if order == LITTLE_ENDIAN else ">"
        kind = cast("int", struct.unpack(f"{prefix}I", self.take(4))[0])
        return prefix, kind

    def count(self, prefix: str) -> int:
        return cast("int", struct.unpack(f"{prefix}I", self.take(4))[0])


def _polygon(reader: _Reader, prefix: str) -> Polygon:
    rings: list[Ring] = []
    for _ in range(reader.count(prefix)):
        size = reader.count(prefix)
        raw = reader.take(size * WKB_POINT_BYTES)
        flat = cast("tuple[float, ...]", struct.unpack(f"{prefix}{size * 2}d", raw))
        rings.append(tuple(zip(flat[0::2], flat[1::2], strict=True)))
    return tuple(rings)


def parse_polygons(wkb: bytes) -> tuple[Polygon, ...]:
    """Read a 2D WKB Polygon or MultiPolygon. Any other geometry fails."""
    reader = _Reader(wkb)
    prefix, kind = reader.header()
    polygons: list[Polygon] = []
    if kind == WKB_POLYGON:
        polygons.append(_polygon(reader, prefix))
    elif kind == WKB_MULTIPOLYGON:
        for _ in range(reader.count(prefix)):
            inner_prefix, inner_kind = reader.header()
            if inner_kind != WKB_POLYGON:
                msg = f"multipolygon holds geometry type {inner_kind}"
                raise SuburbError(msg)
            polygons.append(_polygon(reader, inner_prefix))
    else:
        msg = f"geometry type {kind} is not a polygon or multipolygon"
        raise SuburbError(msg)
    if reader.at != len(wkb):
        msg = "geometry has trailing bytes"
        raise SuburbError(msg)
    return tuple(polygons)


def _ring_centre(ring: Ring) -> tuple[float, Point]:
    """A ring's unsigned area and centroid, computed about its first vertex."""
    if len(ring) < 4 or ring[0] != ring[-1]:  # noqa: PLR2004 - a closed triangle has 4 points
        msg = "a ring is not closed"
        raise SuburbError(msg)
    ox, oy = ring[0]
    twice_area = sx = sy = 0.0
    for (x0, y0), (x1, y1) in pairwise(ring):
        ax, ay, bx, by = x0 - ox, y0 - oy, x1 - ox, y1 - oy
        cross = ax * by - bx * ay
        twice_area += cross
        sx += (ax + bx) * cross
        sy += (ay + by) * cross
    if twice_area == 0:
        msg = "a ring has no area"
        raise SuburbError(msg)
    return abs(twice_area) / 2, (ox + sx / (3 * twice_area), oy + sy / (3 * twice_area))


def centroid(polygons: Iterable[Polygon]) -> Point:
    """Area centroid in the plane of the coordinates, with each hole taken as negative area."""
    total = sx = sy = 0.0
    for polygon in polygons:
        for index, ring in enumerate(polygon):
            area, (cx, cy) = _ring_centre(ring)
            weight = area if index == 0 else -area
            total += weight
            sx += weight * cx
            sy += weight * cy
    if total <= 0:
        msg = "the shape has no area"
        raise SuburbError(msg)
    return sx / total, sy / total


def contains(polygons: Iterable[Polygon], point: Point) -> bool:
    """Even-odd test over every ring of every part, so holes are outside."""
    px, py = point
    crossings = 0
    for polygon in polygons:
        for ring in polygon:
            for (x0, y0), (x1, y1) in pairwise(ring):
                if (y0 > py) != (y1 > py) and px < x0 + (py - y0) * (x1 - x0) / (y1 - y0):
                    crossings += 1
    return crossings % 2 == 1


def _edge_distance(point: Point, polygon: Polygon) -> float:
    px, py = point
    best = float("inf")
    for ring in polygon:
        for (x0, y0), (x1, y1) in pairwise(ring):
            dx, dy = x1 - x0, y1 - y0
            length = dx * dx + dy * dy
            t = (
                0.0
                if length == 0
                else max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / length))
            )
            best = min(best, hypot(px - x0 - t * dx, py - y0 - t * dy))
    return best


def _signed_distance(point: Point, polygon: Polygon) -> float:
    edge = _edge_distance(point, polygon)
    return edge if contains((polygon,), point) else -edge


def _pole(polygon: Polygon) -> Point:
    """The point of a polygon farthest from its edges, by the polylabel cell search."""
    xs = [x for x, _ in polygon[0]]
    ys = [y for _, y in polygon[0]]
    min_x, min_y = min(xs), min(ys)
    size = min(max(xs) - min_x, max(ys) - min_y)
    half = size / 2
    if half == 0:
        return min_x, min_y
    order = count()
    queue: list[tuple[float, int, float, float, float, float]] = []

    def push(x: float, y: float, h: float) -> tuple[float, float, float, float]:
        d = _signed_distance((x, y), polygon)
        heapq.heappush(queue, (-(d + h * sqrt(2)), next(order), x, y, h, d))
        return x, y, h, d

    x = min_x
    while x < max(xs):
        y = min_y
        while y < max(ys):
            push(x + half, y + half, half)
            y += size
        x += size
    cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
    best = (cx, cy, _signed_distance((cx, cy), polygon))
    while queue:
        neg_max, _, x, y, h, d = heapq.heappop(queue)
        if d > best[2]:
            best = (x, y, d)
        if -neg_max - best[2] <= POLE_PRECISION:
            continue
        h /= 2
        for dx, dy in ((-h, -h), (h, -h), (-h, h), (h, h)):
            push(x + dx, y + dy, h)
    return best[0], best[1]


def _part_area(polygon: Polygon) -> float:
    return sum(
        area if i == 0 else -area
        for i, ring in enumerate(polygon)
        for area, _ in [_ring_centre(ring)]
    )


def inside_centre(polygons: tuple[Polygon, ...]) -> Point:
    """The area centroid when it is inside the shape, else the pole of the largest part."""
    middle = centroid(polygons)
    if contains(polygons, middle):
        return middle
    return _pole(max(polygons, key=_part_area))


def centre_of(wkb: bytes) -> tuple[float, float]:
    """The rounded (latitude, longitude) of a WKB shape's centre by the method above."""
    lon, lat = inside_centre(parse_polygons(wkb))
    if not (
        LONGITUDE_RANGE[0] <= lon <= LONGITUDE_RANGE[1]
        and LATITUDE_RANGE[0] <= lat <= LATITUDE_RANGE[1]
    ):
        msg = f"centre {lat}, {lon} is outside Australia and its territories"
        raise SuburbError(msg)
    return round(lat, DECIMAL_PLACES), round(lon, DECIMAL_PLACES)


def _text(row: Row, key: str, where: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value.strip():
        msg = f"{where}: {key} is missing"
        raise SuburbError(msg)
    return value


def build_suburbs(rows: Iterable[Row]) -> Suburbs:
    """One suburb per non-special row, sorted by code, and the sorted special-purpose codes."""
    found: dict[str, Suburb] = {}
    excluded: list[str] = []
    for row in rows:
        code = _text(row, "sal_2021_code", "a row")
        if code in found or code in excluded:
            msg = f"{code}: appears twice"
            raise SuburbError(msg)
        if is_special_purpose(code):
            excluded.append(code)
            continue
        name = _text(row, "sal_2021_name", code)
        state = _text(row, "state_name", code)
        geometry = row.get("geometry")
        if not isinstance(geometry, bytes):
            msg = f"{code}: {name} has no shape"
            raise SuburbError(msg)
        try:
            latitude, longitude = centre_of(geometry)
        except SuburbError as err:
            msg = f"{code}: {name}: {err}"
            raise SuburbError(msg) from err
        found[code] = Suburb(code, name, state, latitude, longitude)
    clashes = sorted(
        f"{state}: {name}"
        for (state, name), n in Counter((s.state, s.name) for s in found.values()).items()
        if n > 1
    )
    if clashes:
        msg = f"names shared within a state: {'; '.join(clashes)}"
        raise SuburbError(msg)
    return Suburbs(tuple(found[c] for c in sorted(found)), tuple(sorted(excluded)))


def shape_rows(path: Path) -> Iterable[Row]:
    columns = ["sal_2021_code", "sal_2021_name", "state_name", "geometry"]
    reader: Any = PQ.ParquetFile(path)
    for batch in reader.iter_batches(batch_size=BATCH_ROWS, columns=columns):
        yield from cast("list[Row]", batch.to_pylist())


def read_suburbs(path: Path) -> Suburbs:
    """Read the boundary file in batches, so its shapes are never all held as Python objects."""
    try:
        return build_suburbs(shape_rows(path))
    except OSError as err:
        msg = f"cannot read {path.name}: {err}"
        raise SuburbError(msg) from err
