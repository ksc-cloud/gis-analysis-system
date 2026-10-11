"""Grid hotspot analysis of one radius analysis: grid-density cells + Getis-Ord Gi* + global Moran's I.

1. Partial input is blocked first (fail closed): complete=false with any incomplete reason, known or unknown,
   returns PARTIAL_RESULT_BLOCKED without computing the grid or any statistic. Missing buildings are not missing
   at random (later pages, timeouts, unreadable geometry), so a hotspot map of the observed buildings could show
   clusters that are only gaps in the data.
2. The grid is computed by app.services.grid_density (all cells, no building ids) from a validated
   GridDensityRequest.
3. A building Python could not repair (excluded as INVALID_GEOMETRY) blocks as well (PYTHON_GEOMETRY_EXCLUDED):
   its area is missing from the coverage of its cells. ZERO_AREA (less than 0.01 m² after repair) and
   OUTSIDE_RADIUS (no area inside the circle) add nothing to any cell and do not block.
4. app.services.hotspot_stats.analyze() on col, row, coverageRatio and smallBoundary of every cell; its results are
   joined to the grid features by position (same ids, geometry and order).

Classes come from the unrounded q-values of analyze(); the response rounds only what it shows.
"""

from app.geo.geometry import GeometryIssue
from app.schemas.building_stats import Note, StatWarning
from app.schemas.grid_density import CellFeature, GridDensityRequest
from app.schemas.hotspot import (NOT_TESTED_REASONS, GlobalMoran, HotspotCellFeature, HotspotCellFeatureCollection,
                                 HotspotCellProperties, HotspotCompleteness, HotspotMethod, HotspotRequest,
                                 HotspotResponse, HotspotSummary)
from app.services import hotspot_stats
from app.services.floors import java_round
from app.services.grid_density import compute_grid_density

#: Codes of the Java RadiusAnalysisResult.ReasonCode. All of them block; a code not listed here blocks too.
KNOWN_INCOMPLETE_REASONS = ("PAGE_LIMIT", "TIME_LIMIT", "EXTERNAL_API_ERROR", "EXTERNAL_API_TIMEOUT",
                            "PAGINATION_INCONSISTENT", "TOTAL_CHANGED", "COUNT_MISMATCH", "TOTAL_UNKNOWN",
                            "GEOMETRY_UNAVAILABLE")

PYTHON_GEOMETRY_EXCLUDED = "PYTHON_GEOMETRY_EXCLUDED"
PARTIAL_RESULT_BLOCKED = "PARTIAL_RESULT_BLOCKED"

#: Shown values: Gi* z to 4 decimals, Moran's I and its moments to 6, p and q to 6 significant digits.
Z_SCALE = 1e4
MORAN_SCALE = 1e6
SIGNIFICANT_DIGITS = 6

_LIMITATIONS = [
    "Gi* p값은 정규 근사입니다. 건폐율이 대부분 0이거나 크게 치우친 분포에서는 실제 유의확률과 다를 수 있습니다.",
    "Benjamini-Hochberg 보정은 검정들이 독립이거나 양의 상관(PRDS)일 때 FDR을 통제합니다. 이웃 셀의 Gi*는 같은 데이터를 "
    "공유하므로 이 조건이 항상 증명되지는 않으며, FDR 수준(10%·5%·1%)은 보장값이 아닌 명목값입니다.",
    "결과는 셀 크기에 따라 달라질 수 있습니다(가변 공간 단위 문제, MAUP). 다른 셀 크기의 결과와 직접 비교하지 마세요.",
    "핫스팟은 주변 셀과 함께 건폐율이 통계적으로 높은 군집, 콜드스팟은 주변보다 유의하게 낮은 군집이라는 뜻입니다. 원인이나 "
    "공식 개발 밀도 지표가 아니며, 콜드스팟이 건물이 없다는 뜻도 아닙니다.",
    "반경 원에 걸친 경계 셀은 원이 셀을 자르는 위치에 따라 건폐율이 내부 셀과 다르게 나올 수 있습니다. 경계를 따라 나타나는 "
    "핫스팟·콜드스팟은 주의해서 해석하세요.",
]


def compute_hotspot(request: HotspotRequest) -> HotspotResponse:
    blocked = blocking_reasons(request)
    if blocked:
        return _blocked(request, blocked, _blocked_warning(blocked, None), _source_completeness(request))

    grid = compute_grid_density(grid_request(request))
    invalid = sum(1 for e in grid.excluded if e.reason == GeometryIssue.INVALID_GEOMETRY)
    if invalid:
        completeness = HotspotCompleteness(
            **_completeness_fields(grid.completeness), source_complete=request.complete,
            python_geometry_excluded=invalid)
        completeness = completeness.model_copy(update={
            "complete": False, "scope": "OBSERVED_BUILDINGS_ONLY",
            "notes": [*completeness.notes, Note(
                targets=["status", "blockedReasons"],
                message=f"Java 분석은 완전했지만 Python이 복구할 수 없는 건물 도형 {invalid}개를 제외해 핫스팟 입력이 "
                        "완전하지 않습니다.")]})
        return _blocked(request, [PYTHON_GEOMETRY_EXCLUDED], _blocked_warning([PYTHON_GEOMETRY_EXCLUDED], invalid),
                        completeness)

    features = grid.cells.features
    cells = [f.properties for f in features]
    stats = hotspot_stats.analyze([c.col for c in cells], [c.row for c in cells], [c.coverage_ratio for c in cells],
                                  [c.small_boundary for c in cells], permutations=request.permutations,
                                  seed=request.seed)
    reasons = dict.fromkeys(NOT_TESTED_REASONS, 0)
    for cell in stats.cells:
        if cell.reason is not None:
            reasons[cell.reason] += 1
    return HotspotResponse(
        source=request.source, center=request.center, radius_meters=request.radius_meters,
        cell_size_meters=request.cell_size_meters, status=stats.status, blocked_reasons=[],
        method=_method(request), grid=grid.grid, counts=grid.counts, moran=_moran(stats.moran),
        summary=HotspotSummary(cell_count=len(features), study_cell_count=stats.study_cell_count,
                               tested_cell_count=stats.tested_cell_count, classes=dict(stats.summary),
                               not_tested_reasons=reasons),
        completeness=HotspotCompleteness(**_completeness_fields(grid.completeness), source_complete=True,
                                         python_geometry_excluded=0),
        warnings=[*grid.warnings, *_status_warnings(stats)],
        cells=HotspotCellFeatureCollection(features=[_feature(f, c) for f, c in zip(features, stats.cells)]))


def blocking_reasons(request: HotspotRequest) -> list[str]:
    """Incomplete reason codes in request order, without repeats; empty when the analysis is complete.
    Every reason blocks (there is no allow list)."""
    if request.complete:
        return []
    return list(dict.fromkeys(reason.code for reason in request.incomplete_reasons))


def grid_request(request: HotspotRequest) -> GridDensityRequest:
    """The grid-density request of the same analysis (every cell, no building ids), validated like any request."""
    data = request.model_dump(exclude={"permutations", "seed"})
    data.update(includeEmptyCells=True, includeCellBuildingIds=False)
    return GridDensityRequest.model_validate(data)


# --------------------------------------------------------------------------------------------- response parts

def _blocked(request: HotspotRequest, reasons: list[str], warning: StatWarning,
             completeness: HotspotCompleteness) -> HotspotResponse:
    return HotspotResponse(
        source=request.source, center=request.center, radius_meters=request.radius_meters,
        cell_size_meters=request.cell_size_meters, status=PARTIAL_RESULT_BLOCKED, blocked_reasons=reasons,
        method=_method(request), grid=None, counts=None, moran=None,
        summary=HotspotSummary(cell_count=0, study_cell_count=0, tested_cell_count=0,
                               classes=dict.fromkeys(hotspot_stats.CLASSES, 0),
                               not_tested_reasons=dict.fromkeys(NOT_TESTED_REASONS, 0)),
        completeness=completeness, warnings=[warning], cells=HotspotCellFeatureCollection(features=[]))


def _source_completeness(request: HotspotRequest) -> HotspotCompleteness:
    """Completeness of a request blocked before any computation (complete=false from Java)."""
    summary = request.java_summary
    return HotspotCompleteness(
        complete=False, scope="OBSERVED_BUILDINGS_ONLY", reasons=request.incomplete_reasons,
        java_outside_excluded=summary.outside_excluded if summary else None,
        java_geometry_unavailable=summary.geometry_unavailable if summary else None,
        notes=[Note(targets=["status", "blockedReasons"],
                    message="Java 반경 분석이 부분 조회 결과여서 격자와 핫스팟 통계를 계산하지 않았습니다.")],
        source_complete=request.complete, python_geometry_excluded=None)


def _completeness_fields(completeness) -> dict:
    return {name: getattr(completeness, name) for name in type(completeness).model_fields}


def _blocked_warning(reasons: list[str], invalid: int | None) -> StatWarning:
    if invalid is not None:
        message = (f"복구할 수 없는 건물 도형 {invalid}개가 계산에서 빠져(INVALID_GEOMETRY) 해당 셀의 건폐율이 실제보다 작을 수 "
                   "있으므로 핫스팟 유의성을 계산하지 않았습니다.")
        return StatWarning(code=PARTIAL_RESULT_BLOCKED, count=invalid, message=message)
    unknown = [code for code in reasons if code not in KNOWN_INCOMPLETE_REASONS]
    message = (f"부분 조회 결과라 핫스팟 유의성을 계산하지 않았습니다(사유: {', '.join(reasons)}). 빠진 건물이 특정 지역에 몰려 "
               "있을 수 있어 핫스팟·콜드스팟 판정이 왜곡됩니다. 반경을 줄이는 등 완전한 조회 결과로 다시 분석하세요.")
    if unknown:
        message += f" 알 수 없는 사유 코드({', '.join(unknown)})도 안전을 위해 차단했습니다."
    return StatWarning(code=PARTIAL_RESULT_BLOCKED, message=message)


def _status_warnings(stats: hotspot_stats.HotspotStats) -> list[StatWarning]:
    if stats.status == hotspot_stats.CONSTANT_VALUES:
        return [StatWarning(code="CONSTANT_VALUES", count=stats.study_cell_count,
                            message="검정 대상 셀의 건폐율이 모두 같아(건물이 없는 경우 포함) 공간 군집을 판정할 수 없습니다. "
                                    "Gi*와 Moran's I를 계산하지 않았습니다.")]
    if stats.status == hotspot_stats.INSUFFICIENT_CELLS:
        return [StatWarning(code="INSUFFICIENT_CELLS", count=stats.study_cell_count,
                            message=f"검정 가능한 셀이 {stats.study_cell_count}개로 최소 "
                                    f"{hotspot_stats.MIN_TESTED_CELLS}개보다 적어 핫스팟을 계산하지 않았습니다. 셀 크기를 "
                                    "줄이거나 반경을 늘려 다시 분석하세요.")]
    if hotspot_stats.SPARSE_VALUES in stats.warnings:
        return [StatWarning(code=hotspot_stats.SPARSE_VALUES, count=stats.tested_cell_count,
                            message=f"건물이 있는 셀이 검정한 셀의 {hotspot_stats.SPARSE_NONZERO_RATIO:.0%} 미만입니다. "
                                    "값이 대부분 0이면 Gi*의 정규 근사가 부정확할 수 있으니 핫스팟 분류는 참고용으로만 "
                                    "보세요.")]
    return []


def _method(request: HotspotRequest) -> HotspotMethod:
    return HotspotMethod(
        permutations=request.permutations, seed=request.seed, limitations=list(_LIMITATIONS),
        description=(
            "격자 셀의 건폐율(coverageRatio)에 Getis-Ord Gi*를 적용했습니다. 이웃은 Queen 인접(8방향)이고 자기 셀을 포함한 "
            "이진 가중치입니다. Gi*는 z점수이며 p값은 정규 근사 양측 검정입니다. 검정한 셀에만 Benjamini-Hochberg 보정을 "
            "적용해 q값이 0.01·0.05·0.10 이하이면 99%·95%·90% 핫스팟(z>0) 또는 콜드스팟(z<0)으로 분류했고, 분류는 반올림 "
            "전 q값으로 정했습니다. 원 안 면적이 셀의 25% 미만인 경계 셀(smallBoundary)과 이웃이 없는 셀은 검정하지 않고 "
            f"이웃으로도 쓰지 않았습니다. 검정할 셀이 {hotspot_stats.MIN_TESTED_CELLS}개 미만이거나 건폐율이 모두 같으면 "
            "계산하지 않습니다. 전역 Moran's I는 자기 셀을 제외한 행 표준화 가중치로 계산하고, 값을 셀에 무작위로 다시 "
            f"배치하는 순열 검정({request.permutations}회, 시드 {request.seed})으로 기댓값 E[I] = -1/(n-1)에서 관측값만큼 "
            "이상 떨어진 비율을 양측 p값으로 냈습니다((극단 횟수 + 1) / (순열 수 + 1))."))


def _moran(moran: hotspot_stats.MoranTest | None) -> GlobalMoran | None:
    if moran is None:
        return None
    return GlobalMoran(
        i=java_round(moran.i, MORAN_SCALE), expected=java_round(moran.expected, MORAN_SCALE), p_value=moran.p_value,
        z_simulated=None if moran.z_simulated is None else java_round(moran.z_simulated, Z_SCALE),
        simulated_mean=java_round(moran.simulated_mean, MORAN_SCALE),
        simulated_sd=java_round(moran.simulated_sd, MORAN_SCALE))


def _feature(feature: CellFeature, cell: hotspot_stats.CellResult) -> HotspotCellFeature:
    return HotspotCellFeature(id=feature.id, geometry=feature.geometry,
                              properties=cell_properties(feature.properties, cell))


def cell_properties(grid_cell, cell: hotspot_stats.CellResult) -> HotspotCellProperties:
    """The grid cell with its hotspot result. Class and bin are copied from analyze(), never recomputed from the
    rounded values."""
    return HotspotCellProperties(
        col=grid_cell.col, row=grid_cell.row, center_lon=grid_cell.center_lon, center_lat=grid_cell.center_lat,
        boundary=grid_cell.boundary, small_boundary=grid_cell.small_boundary, domain_ratio=grid_cell.domain_ratio,
        coverage_ratio=grid_cell.coverage_ratio, neighbor_count=cell.neighbor_count,
        gi_z=None if cell.z is None else java_round(cell.z, Z_SCALE),
        p_value=significant(cell.p_value), q_value=significant(cell.q_value),
        hotspot_class=cell.hotspot_class, bin=cell.bin, reason=cell.reason)


def significant(value: float | None) -> float | None:
    """``value`` to SIGNIFICANT_DIGITS significant digits (small p-values keep their size, unlike fixed decimals)."""
    if value is None:
        return None
    return float(f"{value:.{SIGNIFICANT_DIGITS}g}")
