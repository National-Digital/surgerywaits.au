import math
from collections.abc import Sequence
from dataclasses import dataclass

from surgerywaits.hospitals import Hospital

# Mean Earth radius in km; distances are great-circle (haversine), so state borders do not matter.
EARTH_RADIUS_KM = 6371.0088
NEIGHBOURS = 8
START_RADIUS_KM = 250.0
# Half the Earth's circumference: no two points are further apart, so the search always ends.
MAX_RADIUS_KM = math.pi * EARTH_RADIUS_KM


@dataclass(frozen=True)
class Neighbour:
    code: str
    distance_km: int


@dataclass(frozen=True)
class Mesh:
    code: str
    # The search radius that first held NEIGHBOURS hospitals, or held every candidate.
    radius_km: int
    neighbours: tuple[Neighbour, ...]


@dataclass(frozen=True)
class MeshSet:
    meshes: tuple[Mesh, ...]
    # Hospitals with no coordinates get no mesh and are never given a guessed position.
    without_coordinates: tuple[str, ...]


def distance_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    half = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    )
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(min(1.0, half)))


def _position(h: Hospital) -> tuple[float, float] | None:
    if h.latitude is None or h.longitude is None:
        return None
    return h.latitude, h.longitude


def build_meshes(hospitals: Sequence[Hospital]) -> MeshSet:
    """Each located hospital's nearest open, located hospitals, widening the radius to find them."""
    located = [(h.code, p) for h in hospitals if (p := _position(h)) is not None]
    open_located = [
        (h.code, p) for h in hospitals if not h.closed and (p := _position(h)) is not None
    ]
    meshes: list[Mesh] = []
    for code, origin in sorted(located):
        # Distance then code, so two hospitals the same distance away always order the same way.
        measured = sorted(
            (distance_km(origin, p), other) for other, p in open_located if other != code
        )
        radius = START_RADIUS_KM
        while radius < MAX_RADIUS_KM and sum(d <= radius for d, _ in measured) < NEIGHBOURS:
            radius = min(radius * 2, MAX_RADIUS_KM)
        within = [(d, c) for d, c in measured if d <= radius][:NEIGHBOURS]
        meshes.append(
            Mesh(code, math.ceil(radius), tuple(Neighbour(c, round(d)) for d, c in within))
        )
    missing = sorted(h.code for h in hospitals if _position(h) is None)
    return MeshSet(tuple(meshes), tuple(missing))
