"""Building statistics for one radius analysis. Pure computation: no FastAPI, no I/O.

Areas are in m² on the local tangent plane of the analysis center (same projection as the Java analysis).

* footprint.sumArea      sum of the building areas (parts of one building unioned first, holes removed)
* footprint.unionArea    ground area covered by the buildings: overlaps between buildings count once
* withinRadius.*         the same for the parts inside the circle
* coverageRatio          withinRadius.unionArea / πr²
"""

import math
import statistics
from dataclasses import dataclass

import numpy as np
import shapely

from app.geo import geometry as geo
from app.geo.projection import TOLERANCE_METERS, LocalProjection, Relation, evaluate
from app.schemas.building_stats import (BuildingResult, BuildingStatsRequest, BuildingStatsResponse, Completeness,
                                        Counts, ExcludedBuilding, FloorStats, FootprintStats, Method, Note,
                                        StatWarning, WithinRadiusStats)
from app.services.floors import java_round, summarize_floors, valid_floors

#: Java rounds distanceMeters to 0.01 m; a larger difference means the inputs or formulas differ.
DISTANCE_MATCH_METERS = 0.005 + 1e-6

OUTSIDE_RADIUS = "OUTSIDE_RADIUS"

_COUNT_TARGETS = ["counts", "footprint.sumArea", "footprint.unionArea", "withinRadius.sumArea",
                  "withinRadius.unionArea"]
_DISTRIBUTION_TARGETS = ["footprint.averageArea", "footprint.medianArea", "footprint.minArea", "footprint.maxArea",
                         "floors.average", "floors.min", "floors.max"]
_COVERAGE_TARGETS = ["withinRadius.coverageRatio", "withinRadius.coveragePercent"]
_AREA_TARGETS = ["footprint", "withinRadius"]


@dataclass
class _Analyzed:
    id: str
    relation: Relation
    distance: float
    center_inside: bool
    footprint: geo.Footprint
    floors: int | None
    clipped: shapely.Geometry | None = None
    area_in_radius: float = 0.0


def compute_building_stats(request: BuildingStatsRequest) -> BuildingStatsResponse:
    radius = request.radius_meters
    projection = LocalProjection(request.center.lon, request.center.lat)
    circle = geo.circle(radius)
    circle_error = geo.circle_error(radius)

    analyzed: list[_Analyzed] = []
    excluded: list[ExcludedBuilding] = []
    geometry_failures = 0
    relation_mismatch = 0
    distance_mismatch = 0

    for building in request.buildings:
        projected = [[projection.project_ring(ring) for ring in rings] for rings in building.geometry.polygons()]
        evaluation = evaluate(projected, radius)
        if building.relation is not None and building.relation != evaluation.relation:
            relation_mismatch += 1
        if (building.distance_meters is not None
                and abs(evaluation.distance_meters - building.distance_meters) > DISTANCE_MATCH_METERS):
            distance_mismatch += 1

        footprint = geo.build_footprint(projected)
        if isinstance(footprint, geo.FootprintFailure):
            geometry_failures += 1
            excluded.append(ExcludedBuilding(id=building.id, reason=footprint.issue, message=footprint.message))
            continue
        if evaluation.relation == Relation.OUTSIDE:
            excluded.append(ExcludedBuilding(
                id=building.id, reason=OUTSIDE_RADIUS,
                message=f"반경 원에서 {java_round(evaluation.distance_meters - radius, 100)}m 떨어져 있어 "
                        "분석에서 제외했습니다. 좌표나 반경이 분석 결과와 맞는지 확인하세요."))
            continue
        analyzed.append(_Analyzed(building.id, evaluation.relation, evaluation.distance_meters,
                                  evaluation.center_inside, footprint, valid_floors(building.ground_floor_raw)))

    _clip_to_circle(analyzed, circle)

    footprints = [a.footprint.geometry for a in analyzed]
    areas = [a.footprint.area for a in analyzed]
    footprint_sum = math.fsum(areas)
    footprint_union = shapely.union_all(footprints).area if footprints else 0.0
    within = [a.clipped for a in analyzed if a.clipped is not None]
    within_sum = math.fsum(a.area_in_radius for a in analyzed)
    within_union = shapely.union_all(within).area if within else 0.0
    internal_overlap = math.fsum(a.footprint.internal_overlap_area for a in analyzed)
    between_overlap = max(0.0, footprint_sum - footprint_union)
    within_between_overlap = max(0.0, within_sum - within_union)
    coverage = within_union / circle_error.exact_area

    floors = summarize_floors([b.ground_floor_raw for b in request.buildings])
    duplicate_geometry = _count_duplicate_geometries(footprints)
    repaired = sum(1 for a in analyzed if a.footprint.repaired)
    multi_part_overlap = sum(1 for a in analyzed if a.footprint.internal_overlap_area > 0)
    inside = sum(1 for a in analyzed if a.relation == Relation.INSIDE)
    zero_area = sum(1 for a in analyzed if a.relation == Relation.PARTIAL and a.area_in_radius < geo.MIN_AREA_M2)
    outside = sum(1 for e in excluded if e.reason == OUTSIDE_RADIUS)

    counts = Counts(
        total=len(request.buildings), valid_geometry=len(request.buildings) - geometry_failures,
        analyzed=len(analyzed), repaired=repaired, excluded=len(excluded), inside=inside,
        partial=len(analyzed) - inside, zero_area_in_radius=zero_area, multi_part_overlap=multi_part_overlap,
        duplicate_geometry=duplicate_geometry, relation_mismatch=relation_mismatch,
        distance_mismatch=distance_mismatch)

    warnings: list[StatWarning] = []
    if not request.complete:
        warnings.append(StatWarning(
            code="PARTIAL_RESULT",
            message="반경 분석이 부분 조회 결과입니다. 관측된 건물만 집계했으므로 건물 수와 면적은 실제 전체보다 작을 수 "
                    "있고, 평균·점유율도 지역 전체의 값으로 표시하면 안 됩니다."))
    summary = request.java_summary
    if summary is not None and summary.geometry_unavailable > 0:
        warnings.append(StatWarning(code="JAVA_GEOMETRY_UNAVAILABLE", count=summary.geometry_unavailable,
                                    message="Java 분석에서 도형을 읽지 못한 건물은 이 통계에 포함되지 않았습니다."))
    _warn(warnings, "GEOMETRY_REPAIRED", repaired,
          "유효하지 않은 도형을 복구해 계산했습니다(buildings[].repairReasons 참고).")
    _warn(warnings, "GEOMETRY_EXCLUDED", geometry_failures,
          "복구할 수 없거나 면적이 없는 도형은 제외했습니다(excluded 참고).")
    _warn(warnings, OUTSIDE_RADIUS, outside,
          "반경 원에 닿지 않는 건물은 제외했습니다. 요청의 중심점이나 반경이 분석 결과와 다를 수 있습니다.")
    _warn(warnings, "MULTI_PART_OVERLAP", multi_part_overlap,
          "한 건물 안에서 겹치는 도형 부분은 한 번만 계산했습니다(footprint.internalOverlapArea).")
    if between_overlap >= geo.MIN_AREA_M2:
        warnings.append(StatWarning(
            code="BETWEEN_BUILDING_OVERLAP",
            message=f"서로 다른 건물 도형이 {java_round(between_overlap, 100)}m² 겹칩니다. 단순 합계(sumArea)에는 "
                    "중복 포함, 점유 면적(unionArea)과 점유율에는 한 번만 반영했습니다."))
    _warn(warnings, "DUPLICATE_GEOMETRY", duplicate_geometry,
          "식별자는 다르지만 도형이 같은 건물이 있습니다. 단순 합계에는 중복으로 더해졌습니다.")
    _warn(warnings, "RELATION_MISMATCH", relation_mismatch,
          "요청의 relation과 Python 판정이 다른 건물이 있습니다. 포함 여부는 Python 판정을 사용했습니다.")
    _warn(warnings, "DISTANCE_MISMATCH", distance_mismatch,
          "요청의 distanceMeters와 Python 계산이 0.005m 넘게 다른 건물이 있습니다.")
    _warn(warnings, "FLOOR_DATA_MISSING", floors.without_data,
          "층수 정보가 없거나 0인 건물은 층수 통계에서 제외했습니다(floors.missingBreakdown).")

    return BuildingStatsResponse(
        source=request.source,
        center=request.center,
        radius_meters=radius,
        method=Method(
            projection_description="분석 중심점에 접하는 평면(동쪽 x, 북쪽 y, m)으로 투영합니다. Java PlanarGeometry와 같은 "
                                   "WGS84 곡률반경 공식이며 중심에서 1km 이내 축척 오차는 약 0.01%입니다.",
            tolerance_meters=TOLERANCE_METERS,
            circle_segments=geo.CIRCLE_SEGMENTS,
            circle_area=java_round(circle_error.exact_area, 100),
            circle_polygon_area=java_round(circle_error.polygon_area, 100),
            circle_area_error_ratio=java_round(circle_error.area_error_ratio, 1e10),
            circle_missing_area=_area(circle_error.exact_area - circle_error.polygon_area),
            circle_max_radial_gap_meters=java_round(circle_error.max_radial_gap_meters, 1e4),
            circle_description=(
                f"반경 원은 내접 {geo.CIRCLE_SEGMENTS}각형으로 근사합니다. 다각형 면적은 실제 원보다 "
                f"{circle_error.area_error_ratio * 100:.4f}%({_area(circle_error.exact_area - circle_error.polygon_area)}"
                f"m²) 작고, 경계는 최대 {circle_error.max_radial_gap_meters:.4f}m 안쪽에 있습니다. 근사는 경계에 걸친"
                "(PARTIAL) 건물의 교차 면적에만 쓰며, 완전 포함(INSIDE) 건물은 전체 면적을, 점유율 분모는 실제 원 면적 "
                "πr²을 사용합니다. 따라서 반경 내 점유 면적(unionArea)은 실제보다 최대 circleMissingArea만큼 작을 수 "
                "있고, 원에 조금만 걸친 건물 하나의 교차 면적은 상대적으로 크게 작아질 수 있습니다.")),
        counts=counts,
        footprint=FootprintStats(
            sum_area=_area(footprint_sum), union_area=_area(footprint_union),
            between_building_overlap_area=_area(between_overlap), internal_overlap_area=_area(internal_overlap),
            average_area=_area(footprint_sum / len(areas)) if areas else None,
            median_area=_area(statistics.median(areas)) if areas else None,
            min_area=_area(min(areas)) if areas else None,
            max_area=_area(max(areas)) if areas else None),
        within_radius=WithinRadiusStats(
            sum_area=_area(within_sum), union_area=_area(within_union),
            between_building_overlap_area=_area(within_between_overlap),
            coverage_ratio=java_round(coverage, 1e6), coverage_percent=java_round(coverage * 100, 100)),
        floors=FloorStats(with_data=floors.with_data, without_data=floors.without_data, min=floors.min,
                          max=floors.max, average=floors.average,
                          missing_breakdown={str(k): v for k, v in floors.missing.items()}),
        completeness=Completeness(
            complete=request.complete,
            scope="COMPLETE_RESULT" if request.complete else "OBSERVED_BUILDINGS_ONLY",
            reasons=request.incomplete_reasons,
            java_outside_excluded=summary.outside_excluded if summary else None,
            java_geometry_unavailable=summary.geometry_unavailable if summary else None,
            notes=_notes(request.complete, len(excluded))),
        warnings=warnings,
        excluded=excluded,
        buildings=[_building_result(a) for a in sorted(analyzed, key=lambda a: a.id)]
        if request.include_buildings else None,
    )


def _clip_to_circle(analyzed: list[_Analyzed], circle) -> None:
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


def _count_duplicate_geometries(geometries) -> int:
    if not geometries:
        return 0
    keys = shapely.to_wkb(shapely.normalize(np.array(geometries, dtype=object)))
    return len(keys) - len(set(keys))


def _notes(complete: bool, excluded: int) -> list[Note]:
    notes = [Note(targets=_AREA_TARGETS,
                  message="면적은 VWorld LT_C_SPBD(도로명주소 건물) 도형의 수평 면적(m²)이며 건축물대장의 건축면적이나 "
                          "연면적과 다를 수 있습니다.")]
    if not complete:
        notes += [
            Note(targets=_COUNT_TARGETS,
                 message="관측된 건물만 집계했습니다. 조회되지 않은 건물이 있으므로 실제 전체보다 작을 수 있습니다."),
            Note(targets=_DISTRIBUTION_TARGETS,
                 message="관측된 건물의 값입니다. 조회되지 않은 건물의 분포를 알 수 없어 실제 전체 값과의 차이를 추정할 수 "
                         "없습니다. 지역 전체의 대표값으로 표시하지 마세요."),
            Note(targets=_COVERAGE_TARGETS,
                 message="관측된 건물만으로 계산한 점유율입니다. 지역 전체의 건물 점유율로 표시하지 마세요."),
        ]
    if excluded:
        notes.append(Note(targets=_AREA_TARGETS + ["counts.analyzed"],
                          message=f"분석에서 제외된 건물 {excluded}개는 면적 통계에 포함되지 않았습니다(excluded 참고)."))
    return notes


def _warn(warnings: list[StatWarning], code: str, count: int, message: str) -> None:
    if count:
        warnings.append(StatWarning(code=code, count=count, message=message))


def _area(value: float) -> float:
    return java_round(value, 100)


def _building_result(a: _Analyzed) -> BuildingResult:
    return BuildingResult(
        id=a.id, relation=a.relation, distance_meters=java_round(a.distance, 100), center_inside=a.center_inside,
        footprint_area=_area(a.footprint.area), area_in_radius=_area(a.area_in_radius),
        internal_overlap_area=_area(a.footprint.internal_overlap_area), floors=a.floors,
        repaired=a.footprint.repaired, repair_reasons=list(a.footprint.repair_reasons))
