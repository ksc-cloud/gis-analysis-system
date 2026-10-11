"""Port of the Java ``PlanarGeometry`` (src/main/java/.../analysis/PlanarGeometry.java).

Coordinates are projected onto a plane tangent at the analysis center (x east, y north, meters) using the
WGS84 meridian (M) and prime vertical (N) radii of curvature at the center latitude, exactly like the Java
code, so distances and INSIDE/PARTIAL/OUTSIDE decisions match the radius analysis. Within 1 km of the center
the scale error stays around 0.01 %.

Keep the constants and formulas in sync with the Java class.
"""

import math
from dataclasses import dataclass
from enum import StrEnum

import numpy as np

#: Distances within 1 mm of the radius count as touching the circle (Java TOLERANCE_METERS).
TOLERANCE_METERS = 1e-3

WGS84_A = 6378137.0
WGS84_F = 1 / 298.257223563
WGS84_E2 = WGS84_F * (2 - WGS84_F)


class Relation(StrEnum):
    INSIDE = "INSIDE"
    PARTIAL = "PARTIAL"
    OUTSIDE = "OUTSIDE"


class LocalProjection:
    """Local tangent-plane projection with the center at (0, 0)."""

    def __init__(self, lon0: float, lat0: float) -> None:
        self.lon0 = lon0
        self.lat0 = lat0
        phi = math.radians(lat0)
        sin = math.sin(phi)
        w = math.sqrt(1 - WGS84_E2 * sin * sin)
        n = WGS84_A / w
        m = WGS84_A * (1 - WGS84_E2) / (w * w * w)
        self.meters_per_radian_lon = n * math.cos(phi)
        self.meters_per_radian_lat = m

    def x(self, lon: float) -> float:
        return math.radians(lon - self.lon0) * self.meters_per_radian_lon

    def y(self, lat: float) -> float:
        return math.radians(lat - self.lat0) * self.meters_per_radian_lat

    def lon(self, x: float) -> float:
        return self.lon0 + math.degrees(x / self.meters_per_radian_lon)

    def lat(self, y: float) -> float:
        return self.lat0 + math.degrees(y / self.meters_per_radian_lat)

    def project_ring(self, ring_lon_lat) -> np.ndarray:
        """``[[lon, lat], ...]`` to an (n, 2) array of meters."""
        coords = np.asarray(ring_lon_lat, dtype=np.float64)
        out = np.empty_like(coords)
        out[:, 0] = np.radians(coords[:, 0] - self.lon0) * self.meters_per_radian_lon
        out[:, 1] = np.radians(coords[:, 1] - self.lat0) * self.meters_per_radian_lat
        return out


@dataclass(frozen=True)
class Evaluation:
    """
    relation: how the building relates to the circle
    distance_meters: shortest distance from the center to the footprint (0 when the center is inside)
    center_inside: whether the center is inside the footprint (not in a hole)
    """

    relation: Relation
    distance_meters: float
    center_inside: bool


def evaluate(polygons: list[list[np.ndarray]], radius: float) -> Evaluation:
    """Java ``PlanarGeometry.evaluate`` on already projected polygons (rings, outer ring first).

    * The distance of a polygon is 0 when the center is inside the outer ring and not inside any hole;
      otherwise it is the distance to the nearest edge of any ring.
    * A polygon lies within the disk when every outer-ring vertex does (the disk is convex, holes only
      remove area).
    * INSIDE when every polygon lies within the disk, PARTIAL when at least one polygon is within
      radius + 1 mm, otherwise OUTSIDE. The distance is the minimum over all polygons.
    """
    if not polygons:
        raise ValueError("polygons required")
    min_distance = math.inf
    center_inside = False
    all_within = True
    for rings in polygons:
        contains = contains_origin(rings)
        distance = 0.0 if contains else distance_to_rings(rings)
        center_inside |= contains
        min_distance = min(min_distance, distance)
        all_within &= outer_ring_within(rings[0], radius)
    if all_within:
        relation = Relation.INSIDE
    elif min_distance <= radius + TOLERANCE_METERS:
        relation = Relation.PARTIAL
    else:
        relation = Relation.OUTSIDE
    return Evaluation(relation, min_distance, center_inside)


def contains_origin(rings: list[np.ndarray]) -> bool:
    """Inside the outer ring and not strictly inside any hole."""
    if not ring_contains_origin(rings[0]):
        return False
    return not any(ring_contains_origin(hole) for hole in rings[1:])


def ring_contains_origin(ring: np.ndarray) -> bool:
    """Even-odd ray casting from (0, 0), the same edge pairs and comparisons as the Java loop."""
    xi, yi = ring[:, 0], ring[:, 1]
    # Java pairs vertex i with j = i - 1, and the first vertex with the last one.
    xj, yj = np.roll(xi, 1), np.roll(yi, 1)
    straddles = (yi > 0) != (yj > 0)
    with np.errstate(divide="ignore", invalid="ignore"):
        crossing_x = (xj - xi) * (0 - yi) / (yj - yi) + xi
    crossings = straddles & (0 < crossing_x)
    return bool(np.count_nonzero(crossings) % 2)


def distance_to_rings(rings: list[np.ndarray]) -> float:
    return min(_distance_to_segments(ring) for ring in rings)


def _distance_to_segments(ring: np.ndarray) -> float:
    ax, ay = ring[:-1, 0], ring[:-1, 1]
    bx, by = ring[1:, 0], ring[1:, 1]
    dx = bx - ax
    dy = by - ay
    length_squared = dx * dx + dy * dy
    with np.errstate(divide="ignore", invalid="ignore"):
        t = np.where(length_squared == 0, 0.0, ((0 - ax) * dx + (0 - ay) * dy) / length_squared)
    t = np.clip(t, 0.0, 1.0)
    return float(np.min(np.hypot(0 - (ax + t * dx), 0 - (ay + t * dy))))


def outer_ring_within(outer_ring: np.ndarray, radius: float) -> bool:
    return bool(np.all(np.hypot(outer_ring[:, 0], outer_ring[:, 1]) <= radius + TOLERANCE_METERS))
