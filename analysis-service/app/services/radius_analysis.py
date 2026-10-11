"""Steps shared by every analysis of one Java radius result. Pure computation: no FastAPI, no I/O.

prepare() projects each building onto the local tangent plane of the center, repeats the Java INSIDE/PARTIAL/
OUTSIDE decision, repairs or excludes invalid footprints and clips the analyzed buildings to the radius circle
(INSIDE: whole footprint, PARTIAL: intersection with the inscribed 256-gon). building-stats and grid-density
both start from its result, so they see the same buildings, the same areas and the same exclusions.
"""

import math
from dataclasses import dataclass, field
from functools import cached_property

import numpy as np
import shapely
from shapely.geometry.base import BaseGeometry

from app.geo import geometry as geo
from app.geo.projection import TOLERANCE_METERS, LocalProjection, Relation, evaluate
from app.schemas.building_stats import (Completeness, Counts, ExcludedBuilding, Method, Note, RadiusAnalysisRequest,
                                        StatWarning)
from app.services.floors import java_round, valid_floors

#: Java rounds distanceMeters to 0.01 m; a larger difference means the inputs or formulas differ.
DISTANCE_MATCH_METERS = 0.005 + 1e-6

OUTSIDE_RADIUS = "OUTSIDE_RADIUS"


@dataclass
class AnalyzedBuilding:
    id: str
    relation: Relation
    distance: float
    center_inside: bool
    footprint: geo.Footprint
    floors: int | None
    clipped: BaseGeometry | None = None
    area_in_radius: float = 0.0


@dataclass
class RadiusAnalysis:
    """
    analyzed: buildings that take part in the statistics, in request order
    excluded: buildings left out (invalid geometry or outside the circle), in request order
    """

    request: RadiusAnalysisRequest
    projection: LocalProjection
    circle: BaseGeometry
    circle_error: geo.CircleError
    analyzed: list[AnalyzedBuilding] = field(default_factory=list)
    excluded: list[ExcludedBuilding] = field(default_factory=list)
    geometry_failures: int = 0
    relation_mismatch: int = 0
    distance_mismatch: int = 0

    @property
    def radius(self) -> int:
        return self.request.radius_meters

    @cached_property
    def within_union(self) -> BaseGeometry | None:
        """Ground covered by the analyzed buildings inside the circle, every overlap counted once."""
        within = [a.clipped for a in self.analyzed if a.clipped is not None]
        return shapely.union_all(within) if within else None

    @property
    def within_union_area(self) -> float:
        union = self.within_union
        return union.area if union is not None else 0.0

    @property
    def within_sum_area(self) -> float:
        return math.fsum(a.area_in_radius for a in self.analyzed)


def prepare(request: RadiusAnalysisRequest) -> RadiusAnalysis:
    radius = request.radius_meters
    projection = LocalProjection(request.center.lon, request.center.lat)
    analysis = RadiusAnalysis(request, projection, geo.circle(radius), geo.circle_error(radius))

    for building in request.buildings:
        projected = [[projection.project_ring(ring) for ring in rings] for rings in building.geometry.polygons()]
        evaluation = evaluate(projected, radius)
        if building.relation is not None and building.relation != evaluation.relation:
            analysis.relation_mismatch += 1
        if (building.distance_meters is not None
                and abs(evaluation.distance_meters - building.distance_meters) > DISTANCE_MATCH_METERS):
            analysis.distance_mismatch += 1

        footprint = geo.build_footprint(projected)
        if isinstance(footprint, geo.FootprintFailure):
            analysis.geometry_failures += 1
            analysis.excluded.append(ExcludedBuilding(id=building.id, reason=footprint.issue,
                                                      message=footprint.message))
            continue
        if evaluation.relation == Relation.OUTSIDE:
            analysis.excluded.append(ExcludedBuilding(
                id=building.id, reason=OUTSIDE_RADIUS,
                message=f"반경 원에서 {java_round(evaluation.distance_meters - radius, 100)}m 떨어져 있어 "
                        "분석에서 제외했습니다. 좌표나 반경이 분석 결과와 맞는지 확인하세요."))
            continue
        analysis.analyzed.append(AnalyzedBuilding(building.id, evaluation.relation, evaluation.distance_meters,
                                                  evaluation.center_inside, footprint,
                                                  valid_floors(building.ground_floor_raw)))

    _clip_to_circle(analysis.analyzed, analysis.circle)
    return analysis


def _clip_to_circle(analyzed: list[AnalyzedBuilding], circle) -> None:
    """INSIDE: the whole footprint (exact, the disk is convex). PARTIAL: intersection with the 256-gon."""
    partial = [a for a in analyzed if a.relation == Relation.PARTIAL]
    if partial:
        clipped = shapely.intersection(np.array([a.footprint.geometry for a in partial], dtype=object), circle)
        for building, geometry in zip(partial, clipped):
            area = float(shapely.area(geometry))
            building.area_in_radius = area
            building.clipped = geometry if area > 0 else None
    for building in analyzed:
        if building.relation == Relation.INSIDE:
            building.area_in_radius = building.footprint.area
            building.clipped = building.footprint.geometry


def count_duplicate_geometries(geometries) -> int:
    if not geometries:
        return 0
    keys = shapely.to_wkb(shapely.normalize(np.array(geometries, dtype=object)))
    return len(keys) - len(set(keys))


def counts(analysis: RadiusAnalysis) -> Counts:
    analyzed = analysis.analyzed
    total = len(analysis.request.buildings)
    inside = sum(1 for a in analyzed if a.relation == Relation.INSIDE)
    return Counts(
        total=total, valid_geometry=total - analysis.geometry_failures, analyzed=len(analyzed),
        repaired=sum(1 for a in analyzed if a.footprint.repaired), excluded=len(analysis.excluded), inside=inside,
        partial=len(analyzed) - inside,
        zero_area_in_radius=sum(1 for a in analyzed
                                if a.relation == Relation.PARTIAL and a.area_in_radius < geo.MIN_AREA_M2),
        multi_part_overlap=sum(1 for a in analyzed if a.footprint.internal_overlap_area > 0),
        duplicate_geometry=count_duplicate_geometries([a.footprint.geometry for a in analyzed]),
        relation_mismatch=analysis.relation_mismatch, distance_mismatch=analysis.distance_mismatch)


def warnings(analysis: RadiusAnalysis, counts: Counts, overlap: StatWarning | None) -> list[StatWarning]:
    """Warnings about the input; ``overlap`` is the caller's between-building overlap warning, if any."""
    result: list[StatWarning] = []
    if not analysis.request.complete:
        result.append(StatWarning(
            code="PARTIAL_RESULT",
            message="반경 분석이 부분 조회 결과입니다. 관측된 건물만 집계했으므로 건물 수와 면적은 실제 전체보다 작을 수 "
                    "있고, 평균·점유율도 지역 전체의 값으로 표시하면 안 됩니다."))
    summary = analysis.request.java_summary
    if summary is not None and summary.geometry_unavailable > 0:
        result.append(StatWarning(code="JAVA_GEOMETRY_UNAVAILABLE", count=summary.geometry_unavailable,
                                  message="Java 분석에서 도형을 읽지 못한 건물은 이 통계에 포함되지 않았습니다."))
    outside = sum(1 for e in analysis.excluded if e.reason == OUTSIDE_RADIUS)
    warn(result, "GEOMETRY_REPAIRED", counts.repaired,
         "유효하지 않은 도형을 복구해 계산했습니다(buildings[].repairReasons 참고).")
    warn(result, "GEOMETRY_EXCLUDED", analysis.geometry_failures,
         "복구할 수 없거나 면적이 없는 도형은 제외했습니다(excluded 참고).")
    warn(result, OUTSIDE_RADIUS, outside,
         "반경 원에 닿지 않는 건물은 제외했습니다. 요청의 중심점이나 반경이 분석 결과와 다를 수 있습니다.")
    warn(result, "MULTI_PART_OVERLAP", counts.multi_part_overlap,
         "한 건물 안에서 겹치는 도형 부분은 한 번만 계산했습니다(footprint.internalOverlapArea).")
    if overlap is not None:
        result.append(overlap)
    warn(result, "DUPLICATE_GEOMETRY", counts.duplicate_geometry,
         "식별자는 다르지만 도형이 같은 건물이 있습니다. 단순 합계에는 중복으로 더해졌습니다.")
    warn(result, "RELATION_MISMATCH", counts.relation_mismatch,
         "요청의 relation과 Python 판정이 다른 건물이 있습니다. 포함 여부는 Python 판정을 사용했습니다.")
    warn(result, "DISTANCE_MISMATCH", counts.distance_mismatch,
         "요청의 distanceMeters와 Python 계산이 0.005m 넘게 다른 건물이 있습니다.")
    return result


def warn(warnings: list[StatWarning], code: str, count: int, message: str) -> None:
    if count:
        warnings.append(StatWarning(code=code, count=count, message=message))


def method(analysis: RadiusAnalysis) -> Method:
    circle_error = analysis.circle_error
    missing = area(circle_error.exact_area - circle_error.polygon_area)
    return Method(
        projection_description="분석 중심점에 접하는 평면(동쪽 x, 북쪽 y, m)으로 투영합니다. Java PlanarGeometry와 같은 "
                               "WGS84 곡률반경 공식이며 중심에서 1km 이내 축척 오차는 약 0.01%입니다.",
        tolerance_meters=TOLERANCE_METERS,
        circle_segments=geo.CIRCLE_SEGMENTS,
        circle_area=java_round(circle_error.exact_area, 100),
        circle_polygon_area=java_round(circle_error.polygon_area, 100),
        circle_area_error_ratio=java_round(circle_error.area_error_ratio, 1e10),
        circle_missing_area=missing,
        circle_max_radial_gap_meters=java_round(circle_error.max_radial_gap_meters, 1e4),
        circle_description=(
            f"반경 원은 내접 {geo.CIRCLE_SEGMENTS}각형으로 근사합니다. 다각형 면적은 실제 원보다 "
            f"{circle_error.area_error_ratio * 100:.4f}%({missing}"
            f"m²) 작고, 경계는 최대 {circle_error.max_radial_gap_meters:.4f}m 안쪽에 있습니다. 근사는 경계에 걸친"
            "(PARTIAL) 건물의 교차 면적에만 쓰며, 완전 포함(INSIDE) 건물은 전체 면적을, 점유율 분모는 실제 원 면적 "
            "πr²을 사용합니다. 따라서 반경 내 점유 면적(unionArea)은 실제보다 최대 circleMissingArea만큼 작을 수 "
            "있고, 원에 조금만 걸친 건물 하나의 교차 면적은 상대적으로 크게 작아질 수 있습니다."))


def completeness(analysis: RadiusAnalysis, notes: list[Note]) -> Completeness:
    request = analysis.request
    summary = request.java_summary
    return Completeness(
        complete=request.complete,
        scope="COMPLETE_RESULT" if request.complete else "OBSERVED_BUILDINGS_ONLY",
        reasons=request.incomplete_reasons,
        java_outside_excluded=summary.outside_excluded if summary else None,
        java_geometry_unavailable=summary.geometry_unavailable if summary else None,
        notes=notes)


def area(value: float) -> float:
    return java_round(value, 100)
