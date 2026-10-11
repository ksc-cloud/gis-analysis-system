"""Building footprints in projected meters: validation, repair, union of parts and circle clipping."""

import math
from dataclasses import dataclass
from enum import StrEnum

import shapely
from shapely.geometry.base import BaseGeometry

#: Footprints smaller than this (m²) are treated as having no area.
MIN_AREA_M2 = 0.01

#: quad_segs=64 gives a 256-gon. See circle_error() for its deviation from the true circle.
CIRCLE_QUAD_SEGS = 64
CIRCLE_SEGMENTS = CIRCLE_QUAD_SEGS * 4


class GeometryIssue(StrEnum):
    INVALID_GEOMETRY = "INVALID_GEOMETRY"
    ZERO_AREA = "ZERO_AREA"


@dataclass(frozen=True)
class Footprint:
    """
    geometry: valid polygonal footprint (union of its parts, holes removed)
    area: area of ``geometry`` (m²)
    parts_area: sum of the part areas before the parts were unioned (m²)
    repaired: whether any part was invalid and fixed with make_valid
    repair_reasons: GEOS reasons of the repaired parts, for example "Self-intersection"
    """

    geometry: BaseGeometry
    area: float
    parts_area: float
    repaired: bool
    repair_reasons: tuple[str, ...]

    @property
    def internal_overlap_area(self) -> float:
        """Area counted twice by overlapping parts of the same building (removed from ``area``)."""
        overlap = self.parts_area - self.area
        return overlap if overlap >= MIN_AREA_M2 else 0.0


@dataclass(frozen=True)
class FootprintFailure:
    issue: GeometryIssue
    message: str


def build_footprint(polygons) -> Footprint | FootprintFailure:
    """Builds one building from projected polygons (``[[outer, hole, ...], ...]`` as (n, 2) arrays).

    Each part is checked on its own; an invalid part is repaired with ``make_valid(method="structure")``,
    which keeps the outer ring minus the holes (the GeoJSON meaning). Parts are then unioned, so parts of
    one building that overlap each other (the Java radius analysis merges features with the same bd_mgt_sn)
    count once. That overlap is reported separately and is not a repair.
    """
    parts: list[BaseGeometry] = []
    reasons: list[str] = []
    for rings in polygons:
        polygon = shapely.Polygon(rings[0], rings[1:])
        if not polygon.is_valid:
            reasons.append(_reason_name(shapely.is_valid_reason(polygon)))
            polygon = _polygonal(shapely.make_valid(polygon, method="structure", keep_collapsed=False))
        if polygon is not None and not polygon.is_empty:
            parts.append(polygon)
    if not parts:
        return FootprintFailure(GeometryIssue.INVALID_GEOMETRY, "도형을 복구할 수 없어 분석에서 제외했습니다.")
    parts_area = math.fsum(part.area for part in parts)
    geometry = parts[0] if len(parts) == 1 else _polygonal(shapely.union_all(parts))
    if geometry is None or geometry.is_empty or geometry.area < MIN_AREA_M2:
        return FootprintFailure(GeometryIssue.ZERO_AREA,
                                f"면적이 {MIN_AREA_M2}m² 미만이어서 분석에서 제외했습니다.")
    return Footprint(geometry, geometry.area, parts_area, bool(reasons), tuple(dict.fromkeys(reasons)))


def circle(radius: float) -> BaseGeometry:
    """256-gon inscribed in the circle of ``radius`` around (0, 0)."""
    return shapely.Point(0, 0).buffer(radius, quad_segs=CIRCLE_QUAD_SEGS)


@dataclass(frozen=True)
class CircleError:
    """
    exact_area: πr²
    polygon_area: area of the inscribed 256-gon
    area_error_ratio: (exact - polygon) / exact
    max_radial_gap_meters: largest distance between the polygon edges and the true circle
    """

    exact_area: float
    polygon_area: float
    area_error_ratio: float
    max_radial_gap_meters: float


def circle_error(radius: float) -> CircleError:
    exact = math.pi * radius * radius
    polygon_area = circle(radius).area
    return CircleError(exact, polygon_area, (exact - polygon_area) / exact,
                       radius * (1 - math.cos(math.pi / CIRCLE_SEGMENTS)))


def _polygonal(geometry: BaseGeometry) -> BaseGeometry | None:
    """Keeps only the Polygon/MultiPolygon parts (make_valid may also return lines or points)."""
    if geometry is None or geometry.is_empty:
        return None
    if geometry.geom_type in ("Polygon", "MultiPolygon"):
        return geometry
    if geometry.geom_type == "GeometryCollection":
        polygons = [g for g in shapely.get_parts(geometry) if g.geom_type in ("Polygon", "MultiPolygon")]
        return shapely.union_all(polygons) if polygons else None
    return None


def _reason_name(reason: str) -> str:
    """'Self-intersection[5 5]' -> 'Self-intersection' (coordinates are not reported)."""
    return reason.split("[", 1)[0].strip() or "Invalid geometry"
