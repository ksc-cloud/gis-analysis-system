"""Building density per grid cell for one radius analysis. Pure computation: no FastAPI, no I/O.

Starts from the same prepared analysis as building-stats (app.services.radius_analysis), so the buildings, the
repaired footprints and the parts inside the circle are identical. For every cell of app.geo.grid:

* occupiedArea   area of withinRadius union (building-stats withinRadius.unionArea) inside the cell
* domainArea     area of the cell inside the true circle (exact), the denominator of coverageRatio
* buildingCount  buildings with at least 0.01 m² inside the circle and the cell
* primaryBuildingCount  each analyzed building counted once, in the cell holding its largest part

The cells partition the circle, so the occupied areas add up to withinRadius.unionArea and the domain areas
to πr²; the response reports both differences before and after rounding.
"""

import math
from collections import defaultdict
from dataclasses import dataclass

import numpy as np
import shapely
from shapely.ops import nearest_points

from app.geo import geometry as geo
from app.geo import grid as gridlib
from app.schemas.building_stats import Note, StatWarning
from app.schemas.grid_density import (SMALL_BOUNDARY_RATIO, CellFeature, CellFeatureCollection, CellPolygon,
                                      CellProperties, Consistency, GridDensityRequest, GridDensityResponse,
                                      GridInfo, GridSummary)
from app.services import radius_analysis as pipeline
from app.services.floors import java_round
from app.services.radius_analysis import RadiusAnalysis, area as _area

#: Unrounded cell totals within this of the reference (m²) count as matching (geometry and float error only).
AREA_MATCH_M2 = 1e-3

#: Parts of one building whose areas differ by less than this (m²) are equally large for the primary cell;
#: the first cell in grid order (south-west first) wins.
PRIMARY_TIE_M2 = 1e-6

#: GeoJSON coordinates are rounded to 1e-9 degrees (about 0.1 mm).
COORDINATE_DIGITS = 9

_CELL = "cells.features[].properties."
_COUNT_TARGETS = ["counts", _CELL + "buildingCount", _CELL + "primaryBuildingCount", _CELL + "sumArea",
                  _CELL + "occupiedArea", "summary.sumArea", "summary.occupiedArea", "summary.occupiedCellCount"]
_COVERAGE_TARGETS = [_CELL + "coverageRatio", _CELL + "coveragePercent", "summary.coverageRatio",
                     "summary.coveragePercent"]
_AREA_TARGETS = [_CELL + "sumArea", _CELL + "occupiedArea", "summary"]


def compute_grid_density(request: GridDensityRequest) -> GridDensityResponse:
    analysis = pipeline.prepare(request)
    size = request.cell_size_meters
    cells = gridlib.grid_cells(analysis.radius, size)
    boxes = shapely.box([c.x0 for c in cells], [c.y0 for c in cells], [c.x1 for c in cells], [c.y1 for c in cells])

    occupied = _occupied_areas(analysis, boxes)
    parts = _building_parts(analysis, boxes)
    sum_area = np.zeros(len(cells))
    members: list[list[int]] = [[] for _ in cells]
    for cell, building, part_area in zip(parts.cells, parts.buildings, parts.areas):
        sum_area[cell] += part_area
        if part_area >= geo.MIN_AREA_M2:
            members[cell].append(building)
    primary, by_nearest = _primary_cells(analysis, boxes, parts)
    primary_count = np.bincount(np.asarray(primary, dtype=np.int64), minlength=len(cells))

    projection = analysis.projection
    features: list[CellFeature] = []
    empty = boundary = small_boundary = occupied_cells = 0
    for index, cell in enumerate(cells):
        ids = sorted(analysis.analyzed[b].id for b in members[index])
        is_boundary = cell.domain_area < cell.cell_area - gridlib.MIN_DOMAIN_AREA_M2
        is_small = is_boundary and cell.domain_ratio < SMALL_BOUNDARY_RATIO
        is_empty = not ids and int(primary_count[index]) == 0
        boundary += is_boundary
        small_boundary += is_small
        empty += is_empty
        occupied_cells += bool(ids)
        if is_empty and not request.include_empty_cells:
            continue
        coverage = occupied[index] / cell.domain_area
        features.append(CellFeature(
            id=f"{cell.col}:{cell.row}",
            geometry=CellPolygon(coordinates=[_ring(projection, cell)]),
            properties=CellProperties(
                col=cell.col, row=cell.row,
                center_lon=round(projection.lon((cell.x0 + cell.x1) / 2), COORDINATE_DIGITS),
                center_lat=round(projection.lat((cell.y0 + cell.y1) / 2), COORDINATE_DIGITS),
                cell_area=_area(cell.cell_area), domain_area=_area(cell.domain_area),
                domain_ratio=java_round(cell.domain_ratio, 1e6), boundary=is_boundary, small_boundary=is_small,
                building_count=len(ids), primary_building_count=int(primary_count[index]),
                sum_area=_area(sum_area[index]), occupied_area=_area(occupied[index]),
                between_building_overlap_area=_area(max(0.0, sum_area[index] - occupied[index])),
                coverage_ratio=java_round(coverage, 1e6), coverage_percent=java_round(coverage * 100, 100),
                building_ids=ids if request.include_cell_building_ids else None)))

    union_area = analysis.within_union_area
    circle_area = analysis.circle_error.exact_area
    occupied_total = math.fsum(occupied)
    domain_total = math.fsum(c.domain_area for c in cells)
    within_sum = analysis.within_sum_area
    counts = pipeline.counts(analysis)

    overlap = None
    within_overlap = within_sum - union_area
    if within_overlap >= geo.MIN_AREA_M2:
        overlap = StatWarning(
            code="BETWEEN_BUILDING_OVERLAP",
            message=f"반경 안에서 서로 다른 건물 도형이 {java_round(within_overlap, 100)}m² 겹칩니다. 셀의 sumArea에는 "
                    "중복 포함, occupiedArea와 점유율에는 한 번만 반영했습니다.")
    warnings = pipeline.warnings(analysis, counts, overlap)
    pipeline.warn(warnings, "SMALL_BOUNDARY_CELLS", small_boundary,
                  f"반경 원 안의 면적이 셀 면적의 {SMALL_BOUNDARY_RATIO:.0%} 미만인 경계 셀(smallBoundary)은 분모가 작아 "
                  "건물 하나로도 점유율이 크게 달라집니다. 다른 셀과 같은 기준의 밀집도로 비교하지 마세요.")

    return GridDensityResponse(
        source=request.source,
        center=request.center,
        radius_meters=analysis.radius,
        cell_size_meters=size,
        method=pipeline.method(analysis),
        grid=GridInfo(
            cell_size_meters=size, cell_area=_area(size * size),
            columns=(min(c.col for c in cells), max(c.col for c in cells)),
            rows=(min(c.row for c in cells), max(c.row for c in cells)),
            cell_count=len(cells), returned_cell_count=len(features), empty_cell_count=empty,
            boundary_cell_count=boundary, small_boundary_cell_count=small_boundary,
            min_building_area_in_cell=geo.MIN_AREA_M2,
            description=(
                f"{size}m 정사각형 격자입니다. 셀 (0,0)의 중심이 분석 중심점이고 col은 동쪽, row는 북쪽으로 증가합니다. "
                "격자는 분석 중심점의 접평면(m)에서 만들고 GeoJSON 좌표는 같은 투영의 역변환(WGS84 경위도, 소수 9자리)입니다. "
                "반경 원과 면적을 공유하는 셀만 포함하며, 경계 셀도 정사각형 전체를 반환하지만 점유율의 분모(domainArea)는 "
                "실제 원과 셀의 교집합 면적(해석적 계산)입니다."),
            comparison_with_building_stats=(
                "건물 선정, 도형 복구, 반경 판정, 256각형 절단은 building-stats와 같습니다. 모든 셀의 occupiedArea 합계는 "
                "withinRadius.unionArea, domainArea 합계는 πr²(method.circleArea)이므로 전체 점유율은 "
                "withinRadius.coverageRatio와 같습니다. 차이: (1) 경계 셀의 분자는 256각형으로 자른 면적이고 분모는 실제 "
                "원 기준이므로, 전체 점유율과 같은 방식으로 경계 셀 점유율이 실제보다 조금 작을 수 있습니다. "
                f"(2) buildingCount는 셀 안 면적이 {geo.MIN_AREA_M2}m² 이상인 건물 수이므로 여러 셀에 걸친 건물은 각 셀에서 "
                "세고, 합계가 counts.analyzed보다 클 수 있습니다. primaryBuildingCount는 건물마다 한 셀에서만 셉니다. "
                "(3) 반경 안 면적이 없는 PARTIAL 건물(counts.zeroAreaInRadius)은 buildingCount에 들어가지 않고, "
                "primaryBuildingCount만 중심에 가장 가까운 지점이 있는 셀(summary.primaryByNearestCell)에 더합니다. "
                "(4) 층수 통계는 계산하지 않습니다.")),
        counts=counts,
        summary=GridSummary(
            domain_area=_area(domain_total), sum_area=_area(within_sum), occupied_area=_area(occupied_total),
            coverage_ratio=java_round(occupied_total / circle_area, 1e6),
            coverage_percent=java_round(occupied_total / circle_area * 100, 100),
            occupied_cell_count=occupied_cells, primary_building_count=int(primary_count.sum()),
            primary_by_nearest_cell=by_nearest),
        consistency=Consistency(
            within_radius_union_area=_area(union_area),
            occupied_area_calculation_difference=occupied_total - union_area,
            occupied_area_display_difference=java_round(math.fsum(_area(a) for a in occupied) - _area(union_area),
                                                        100),
            occupied_area_matches=abs(occupied_total - union_area) <= AREA_MATCH_M2,
            circle_area=_area(circle_area),
            domain_area_calculation_difference=domain_total - circle_area,
            domain_area_display_difference=java_round(math.fsum(_area(c.domain_area) for c in cells)
                                                      - _area(circle_area), 100),
            analyzed_buildings=len(analysis.analyzed),
            primary_building_total=int(primary_count.sum()),
            primary_matches_analyzed=int(primary_count.sum()) == len(analysis.analyzed),
            description=(
                "calculationDifference는 반올림하지 않은 셀 값의 합계와 기준값(withinRadius.unionArea 또는 πr²)의 "
                "차이로 실제 계산 오차(부동소수점·도형 연산)입니다. displayDifference는 응답에 표시된(소수 2자리로 "
                f"반올림한) 셀 값의 합계와 표시된 기준값의 차이로 반올림 때문에만 생깁니다. 계산 오차가 {AREA_MATCH_M2}m² "
                "이하이면 occupiedAreaMatches가 true입니다. 합계는 includeEmptyCells와 관계없이 모든 셀로 계산합니다.")),
        completeness=pipeline.completeness(analysis, _notes(request.complete, len(analysis.excluded))),
        warnings=warnings,
        excluded=analysis.excluded,
        cells=CellFeatureCollection(features=features),
    )


def _occupied_areas(analysis: RadiusAnalysis, boxes: np.ndarray) -> np.ndarray:
    """Area of the withinRadius union in each cell. The union's parts do not overlap, so their areas add up."""
    occupied = np.zeros(len(boxes))
    union = analysis.within_union
    if union is None:
        return occupied
    parts = shapely.get_parts(union)
    cell_index, part_index = shapely.STRtree(parts).query(boxes, predicate="intersects")
    areas = shapely.area(shapely.intersection(parts[part_index], boxes[cell_index]))
    return np.bincount(cell_index, weights=areas, minlength=len(boxes))


@dataclass(frozen=True)
class _Parts:
    """Pieces of each building (inside the circle) per cell: cells[i], buildings[i] (analyzed index), areas[i]."""

    cells: np.ndarray
    buildings: np.ndarray
    areas: np.ndarray


def _building_parts(analysis: RadiusAnalysis, boxes: np.ndarray) -> _Parts:
    indexes = np.array([i for i, a in enumerate(analysis.analyzed) if a.clipped is not None], dtype=np.int64)
    if len(indexes) == 0:
        none = np.array([], dtype=np.int64)
        return _Parts(none, none, np.array([], dtype=np.float64))
    geometries = np.array([analysis.analyzed[i].clipped for i in indexes], dtype=object)
    cell_index, geometry_index = shapely.STRtree(geometries).query(boxes, predicate="intersects")
    areas = shapely.area(shapely.intersection(geometries[geometry_index], boxes[cell_index]))
    order = np.lexsort((cell_index, indexes[geometry_index]))
    return _Parts(cell_index[order], indexes[geometry_index][order], areas[order])


def _primary_cells(analysis: RadiusAnalysis, boxes: np.ndarray, parts: _Parts) -> tuple[list[int], int]:
    """One cell per analyzed building: the cell with its largest part inside the circle (ties: lowest cell index).

    A building without area inside the circle (it only touches the circle) goes to the cell nearest to the point
    of its footprint closest to the center. Returns the cells and how many buildings were placed that way.
    """
    candidates: dict[int, list[tuple[float, int]]] = defaultdict(list)
    for cell, building, part_area in zip(parts.cells, parts.buildings, parts.areas):
        if part_area > 0:
            candidates[int(building)].append((float(part_area), int(cell)))
    tree = None
    primary: list[int] = []
    by_nearest = 0
    for index, building in enumerate(analysis.analyzed):
        found = candidates.get(index)
        if found:
            largest = max(a for a, _ in found)
            primary.append(min(c for a, c in found if a >= largest - PRIMARY_TIE_M2))
            continue
        tree = tree or shapely.STRtree(boxes)
        point = nearest_points(building.footprint.geometry, shapely.Point(0, 0))[0]
        primary.append(int(np.min(tree.query_nearest(point, all_matches=True))))
        by_nearest += 1
    return primary, by_nearest


def _ring(projection, cell: gridlib.Cell) -> list[tuple[float, float]]:
    """Counterclockwise (RFC 7946 exterior ring), closed."""
    corners = [(cell.x0, cell.y0), (cell.x1, cell.y0), (cell.x1, cell.y1), (cell.x0, cell.y1), (cell.x0, cell.y0)]
    return [(round(projection.lon(x), COORDINATE_DIGITS), round(projection.lat(y), COORDINATE_DIGITS))
            for x, y in corners]


def _notes(complete: bool, excluded: int) -> list[Note]:
    notes = [Note(targets=_AREA_TARGETS,
                  message="면적은 VWorld LT_C_SPBD(도로명주소 건물) 도형의 수평 면적(m²)이며 건축물대장의 건축면적이나 "
                          "연면적과 다를 수 있습니다.")]
    if not complete:
        notes += [
            Note(targets=_COUNT_TARGETS,
                 message="관측된 건물만 집계했습니다. 조회되지 않은 건물이 있으므로 셀별 건물 수와 면적은 실제보다 작을 수 "
                         "있고, 건물이 없는 셀도 실제로 비어 있다는 뜻이 아닙니다."),
            Note(targets=_COVERAGE_TARGETS,
                 message="관측된 건물만으로 계산한 점유율입니다. 지역 전체의 건물 밀집도로 표시하거나 셀끼리의 밀집도 "
                         "순위로 해석하지 마세요."),
        ]
    if excluded:
        notes.append(Note(targets=_AREA_TARGETS + ["counts.analyzed"],
                          message=f"분석에서 제외된 건물 {excluded}개는 격자 집계에 포함되지 않았습니다(excluded 참고)."))
    return notes
