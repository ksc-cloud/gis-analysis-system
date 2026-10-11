"""Building statistics for one radius analysis. Pure computation: no FastAPI, no I/O.

Areas are in m² on the local tangent plane of the analysis center (same projection as the Java analysis).

* footprint.sumArea      sum of the building areas (parts of one building unioned first, holes removed)
* footprint.unionArea    ground area covered by the buildings: overlaps between buildings count once
* withinRadius.*         the same for the parts inside the circle
* coverageRatio          withinRadius.unionArea / πr²
"""

import math
import statistics

import shapely

from app.geo import geometry as geo
from app.schemas.building_stats import (BuildingResult, BuildingStatsRequest, BuildingStatsResponse, FloorStats,
                                        FootprintStats, Note, StatWarning, WithinRadiusStats)
from app.services import radius_analysis as pipeline
from app.services.floors import java_round, summarize_floors
from app.services.radius_analysis import AnalyzedBuilding, area as _area

_COUNT_TARGETS = ["counts", "footprint.sumArea", "footprint.unionArea", "withinRadius.sumArea",
                  "withinRadius.unionArea"]
_DISTRIBUTION_TARGETS = ["footprint.averageArea", "footprint.medianArea", "footprint.minArea", "footprint.maxArea",
                         "floors.average", "floors.min", "floors.max"]
_COVERAGE_TARGETS = ["withinRadius.coverageRatio", "withinRadius.coveragePercent"]
_AREA_TARGETS = ["footprint", "withinRadius"]


def compute_building_stats(request: BuildingStatsRequest) -> BuildingStatsResponse:
    analysis = pipeline.prepare(request)
    analyzed = analysis.analyzed

    footprints = [a.footprint.geometry for a in analyzed]
    areas = [a.footprint.area for a in analyzed]
    footprint_sum = math.fsum(areas)
    footprint_union = shapely.union_all(footprints).area if footprints else 0.0
    within_sum = analysis.within_sum_area
    within_union = analysis.within_union_area
    internal_overlap = math.fsum(a.footprint.internal_overlap_area for a in analyzed)
    between_overlap = max(0.0, footprint_sum - footprint_union)
    within_between_overlap = max(0.0, within_sum - within_union)
    coverage = within_union / analysis.circle_error.exact_area

    floors = summarize_floors([b.ground_floor_raw for b in request.buildings])
    counts = pipeline.counts(analysis)

    overlap = None
    if between_overlap >= geo.MIN_AREA_M2:
        overlap = StatWarning(
            code="BETWEEN_BUILDING_OVERLAP",
            message=f"서로 다른 건물 도형이 {java_round(between_overlap, 100)}m² 겹칩니다. 단순 합계(sumArea)에는 "
                    "중복 포함, 점유 면적(unionArea)과 점유율에는 한 번만 반영했습니다.")
    warnings = pipeline.warnings(analysis, counts, overlap)
    pipeline.warn(warnings, "FLOOR_DATA_MISSING", floors.without_data,
                  "층수 정보가 없거나 0인 건물은 층수 통계에서 제외했습니다(floors.missingBreakdown).")

    return BuildingStatsResponse(
        source=request.source,
        center=request.center,
        radius_meters=request.radius_meters,
        method=pipeline.method(analysis),
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
        completeness=pipeline.completeness(analysis, _notes(request.complete, len(analysis.excluded))),
        warnings=warnings,
        excluded=analysis.excluded,
        buildings=[_building_result(a) for a in sorted(analyzed, key=lambda a: a.id)]
        if request.include_buildings else None,
    )


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


def _building_result(a: AnalyzedBuilding) -> BuildingResult:
    return BuildingResult(
        id=a.id, relation=a.relation, distance_meters=java_round(a.distance, 100), center_inside=a.center_inside,
        footprint_area=_area(a.footprint.area), area_in_radius=_area(a.area_in_radius),
        internal_overlap_area=_area(a.footprint.internal_overlap_area), floors=a.floors,
        repaired=a.footprint.repaired, repair_reasons=list(a.footprint.repair_reasons))
