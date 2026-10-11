"""Comparison of two saved radius analyses. Pure computation: no FastAPI, no I/O.

Both analyses go through the building-stats pipeline (app.services.radius_analysis.prepare), so areas, repairs and
exclusions are exactly those of building-stats. Then:

1. Conditions: the same center (within 0.05 m), radius, criterion, data source and coordinate system, otherwise
   comparable=false and no statistics.
2. Statistics: unrounded building-stats totals of each side; delta = after - before, rate = delta / before.
3. Buildings, by identifier only:
   * bd:<bd_mgt_sn>   same id = same building (confidence HIGH)
   * feature:<id>     same id and footprint IoU >= 0.5 = same building (MEDIUM), otherwise FEATURE_ID_UNVERIFIED
   * row:<index>      never matched (the index depends on the order of one VWorld response)
   A repaired footprint on either side lowers the confidence to LOW; an excluded footprint makes the id
   uncomparable. Buildings left unmatched may get possible-same-building candidates (IoU >= 0.9), which are only
   reported and never change a status.
"""

import math
from dataclasses import dataclass

import numpy as np
import shapely

from app.geo import geometry as geo
from app.schemas.building_stats import ExcludedBuilding, Note, StatWarning
from app.schemas.compare import (AnalysisSummary, BuildingChange, BuildingComparison, BuildingState,
                                 BuildingSummary, Candidate, CompareMethod, CompareRequest, CompareResponse,
                                 Conditions, FloorChange, IdentifierCounts, Match, Metric, RatioMetric, Reason,
                                 SavedAnalysis, Statistics, UncomparableBuilding)
from app.services import radius_analysis as pipeline
from app.services.building_stats import RawStatistics, raw_statistics
from app.services.floors import java_round
from app.services.radius_analysis import OUTSIDE_RADIUS, AnalyzedBuilding, RadiusAnalysis

CRITERION = "POLYGON_INTERSECTS_CIRCLE"
CENTER_TOLERANCE_METERS = 0.05
FEATURE_IOU_THRESHOLD = 0.5
CANDIDATE_IOU_THRESHOLD = 0.9
#: Footprints whose symmetric difference is below this (m²) have the same geometry.
GEOMETRY_TOLERANCE_M2 = geo.MIN_AREA_M2

CHANGE = "CHANGE"
OBSERVATION = "OBSERVATION_DIFFERENCE"

_STATUS_ORDER = {s: i for i, s in enumerate(
    ["ADDED", "ONLY_IN_AFTER", "REMOVED", "ONLY_IN_BEFORE", "MODIFIED", "UNCHANGED"])}


def compare_analyses(request: CompareRequest) -> CompareResponse:
    before = pipeline.prepare(request.before)
    after = pipeline.prepare(request.after)
    conditions, reasons = _conditions(request, before)
    comparable = not reasons
    basis = CHANGE if conditions.both_complete else OBSERVATION

    statistics = buildings = None
    warnings: list[StatWarning] = []
    if basis == OBSERVATION:
        warnings.append(StatWarning(
            code=OBSERVATION,
            message="한쪽 이상이 부분 조회 결과입니다. 차이는 관측된 건물의 차이이며 실제 건물 변화로 단정할 수 없습니다. "
                    "한쪽에만 있는 건물(ONLY_IN_BEFORE/ONLY_IN_AFTER)은 조회 범위 차이일 수 있습니다."))
    if conditions.analyzed_interval_seconds == 0:
        warnings.append(StatWarning(
            code="SAME_ANALYZED_AT",
            message="두 분석의 시점이 같습니다. 차이가 있다면 데이터 변화가 아니라 조회 과정의 차이일 수 있습니다."))
    if comparable:
        statistics = _statistics(raw_statistics(before), raw_statistics(after), request, basis)
        buildings = _buildings(before, after, request, basis, warnings)

    return CompareResponse(
        comparable=comparable,
        comparison_basis=basis,
        not_comparable_reasons=reasons,
        before=_summary(request.before, before),
        after=_summary(request.after, after),
        conditions=conditions,
        method=CompareMethod(
            center_tolerance_meters=CENTER_TOLERANCE_METERS,
            feature_iou_threshold=FEATURE_IOU_THRESHOLD,
            candidate_iou_threshold=CANDIDATE_IOU_THRESHOLD,
            geometry_tolerance_m2=GEOMETRY_TOLERANCE_M2,
            matching_description=(
                "건물은 식별자로만 매칭합니다. bd:(건물관리번호)가 같으면 같은 건물(신뢰도 HIGH), feature:(VWorld 객체 ID)는 "
                f"ID가 같고 전체 도형 IoU가 {FEATURE_IOU_THRESHOLD} 이상일 때만 같은 건물(MEDIUM)로 봅니다. row:는 분석마다 "
                "바뀌는 순번이므로 매칭하지 않습니다. 어느 쪽이든 도형을 복구한 건물은 신뢰도를 LOW로 낮추고, 도형이 제외된 "
                f"건물은 비교하지 않습니다. 매칭되지 않은 건물끼리 IoU {CANDIDATE_IOU_THRESHOLD} 이상인 쌍은 "
                "possibleSameBuilding 후보로만 보고하며, 두 건물 모두 그 쌍이 유일할 때 CANDIDATE, 아니면 AMBIGUOUS입니다. "
                "후보는 추가·삭제·유지 판정에 쓰지 않습니다. 도형 변화(GEOMETRY)는 전체 도형의 대칭차 면적이 "
                f"{GEOMETRY_TOLERANCE_M2}m² 이상일 때입니다."),
            statistics_description=(
                "각 분석의 지표는 building-stats와 같은 계산(같은 투영·도형 복구·반경 판정)의 반올림 전 값입니다. "
                "delta = after − before, changeRate = delta / before(before가 0이거나 값이 없으면 null)이며 점유율 변화는 "
                "deltaPercentPoint(%p)로도 제공합니다. 반올림은 응답에서만 합니다(면적 0.01m², 비율 1e-6, %p 1e-4)."),
            analysis=pipeline.method(before) if comparable else None),
        statistics=statistics,
        buildings=buildings,
        warnings=warnings,
        notes=_notes(basis),
    )


# ----------------------------------------------------------------------------------------- conditions

def _conditions(request: CompareRequest, before: RadiusAnalysis) -> tuple[Conditions, list[Reason]]:
    b, a = request.before, request.after
    projection = before.projection
    distance = math.hypot(projection.x(a.center.lon), projection.y(a.center.lat))
    same_center = distance <= CENTER_TOLERANCE_METERS
    same_radius = b.radius_meters == a.radius_meters
    same_criterion = b.criterion == a.criterion == CRITERION
    same_source = (b.data_source.provider.strip() == a.data_source.provider.strip()
                   and b.data_source.layer.strip() == a.data_source.layer.strip())
    same_crs = b.data_source.coordinate_system.strip() == a.data_source.coordinate_system.strip()

    reasons = []
    if not same_center:
        reasons.append(Reason(code="CENTER_DIFFERENT",
                              message=f"분석 중심점이 {java_round(distance, 1000)}m 떨어져 있습니다(허용 "
                                      f"{CENTER_TOLERANCE_METERS}m). 중심이 다른 분석은 직접 비교하지 않습니다."))
    if not same_radius:
        reasons.append(Reason(code="RADIUS_DIFFERENT",
                              message=f"분석 반경이 다릅니다({b.radius_meters}m, {a.radius_meters}m)."))
    if b.criterion != a.criterion:
        reasons.append(Reason(code="CRITERION_DIFFERENT", message="두 분석의 건물 포함 기준(criterion)이 다릅니다."))
    elif not same_criterion:
        reasons.append(Reason(code="CRITERION_UNSUPPORTED",
                              message=f"지원하지 않는 포함 기준입니다. {CRITERION}만 비교할 수 있습니다."))
    if not same_source:
        reasons.append(Reason(code="DATA_SOURCE_DIFFERENT",
                              message="두 분석의 데이터 출처(provider, layer)가 다릅니다."))
    if not same_crs:
        reasons.append(Reason(code="COORDINATE_SYSTEM_DIFFERENT", message="두 분석의 좌표계가 다릅니다."))

    conditions = Conditions(
        center_distance_meters=java_round(distance, 1e4), center_tolerance_meters=CENTER_TOLERANCE_METERS,
        same_center=same_center, same_radius=same_radius, same_criterion=same_criterion,
        same_data_source=same_source, same_coordinate_system=same_crs,
        analyzed_interval_seconds=(a.source.analyzed_at - b.source.analyzed_at).total_seconds(),
        both_complete=b.complete and a.complete)
    return conditions, reasons


def _summary(request: SavedAnalysis, analysis: RadiusAnalysis) -> AnalysisSummary:
    counts = pipeline.counts(analysis)
    kinds = [_kind(b.id) for b in request.buildings]
    return AnalysisSummary(
        source=request.source, center=request.center, radius_meters=request.radius_meters,
        complete=request.complete, incomplete_reasons=request.incomplete_reasons, criterion=request.criterion,
        data_source=request.data_source, counts=counts,
        identifiers=IdentifierCounts(bd=kinds.count("bd"), feature=kinds.count("feature"), row=kinds.count("row"),
                                     other=kinds.count("other")),
        warnings=pipeline.warnings(analysis, counts, None))


def _kind(building_id: str) -> str:
    prefix = building_id.split(":", 1)[0] if ":" in building_id else ""
    return prefix if prefix in ("bd", "feature", "row") else "other"


# ----------------------------------------------------------------------------------------- statistics

def _metric(unit: str, before, after, scale: float | None) -> Metric:
    return Metric(unit=unit, **_values(before, after, scale))


def _values(before, after, scale: float | None) -> dict:
    delta = after - before if before is not None and after is not None else None
    rate = delta / before if delta is not None and before != 0 else None

    def show(value):
        return value if value is None or scale is None else java_round(value, scale)

    return {"before": show(before), "after": show(after), "delta": show(delta),
            "change_rate": None if rate is None else java_round(rate, 1e6)}


def _statistics(b: RawStatistics, a: RawStatistics, request: CompareRequest, basis: str) -> Statistics:
    java_b, java_a = request.before.java_summary, request.after.java_summary
    coverage = _values(b.coverage, a.coverage, 1e6)
    return Statistics(
        basis=basis,
        interpretation=(
            "두 분석 모두 완전한 결과이므로 차이를 VWorld 데이터의 변화로 볼 수 있습니다. 실제 공사 시점과는 다를 수 "
            "있습니다." if basis == CHANGE else
            "한쪽 이상이 부분 조회이므로 차이는 관측된 건물의 차이입니다. 실제 건물 수·면적·점유율의 변화로 표시하지 "
            "마세요."),
        building_count=_metric("count", len(b.areas), len(a.areas), None),
        java_building_count=(_metric("count", java_b.intersecting, java_a.intersecting, None)
                             if java_b is not None and java_a is not None else None),
        union_area=_metric("m2", b.within_union, a.within_union, 100),
        sum_area=_metric("m2", b.footprint_sum, a.footprint_sum, 100),
        coverage_ratio=RatioMetric(unit="ratio", **coverage,
                                   delta_percent_point=java_round((a.coverage - b.coverage) * 100, 1e4)),
        average_area=_metric("m2", b.average_area, a.average_area, 100),
        average_floors=_metric("floors", b.average_floors, a.average_floors, 100),
        floors_with_data=_metric("count", len(b.floor_values), len(a.floor_values), None))


# ----------------------------------------------------------------------------------------- buildings

@dataclass
class _Side:
    analyzed: dict[str, AnalyzedBuilding]
    excluded: dict[str, ExcludedBuilding]
    raw_floors: dict[str, str | None]

    @classmethod
    def of(cls, request: SavedAnalysis, analysis: RadiusAnalysis) -> "_Side":
        return cls({a.id: a for a in analysis.analyzed}, {e.id: e for e in analysis.excluded},
                   {b.id: b.ground_floor_raw for b in request.buildings})


def _buildings(before: RadiusAnalysis, after: RadiusAnalysis, request: CompareRequest, basis: str,
               warnings: list[StatWarning]) -> BuildingComparison:
    sides = {"BEFORE": _Side.of(request.before, before), "AFTER": _Side.of(request.after, after)}
    b_side, a_side = sides["BEFORE"], sides["AFTER"]
    changes: list[BuildingChange] = []
    uncomparable: list[UncomparableBuilding] = []
    pool: dict[str, list[AnalyzedBuilding]] = {"BEFORE": [], "AFTER": []}
    same_id: list[tuple[str, AnalyzedBuilding, AnalyzedBuilding]] = []

    ids = sorted(set(b_side.analyzed) | set(b_side.excluded) | set(a_side.analyzed) | set(a_side.excluded))
    for building_id in ids:
        kind = _kind(building_id)
        present = {side: s.analyzed.get(building_id) for side, s in sides.items()}
        excluded = {side: s.excluded.get(building_id) for side, s in sides.items()}
        if any(excluded.values()):
            for side in sides:
                other = "AFTER" if side == "BEFORE" else "BEFORE"
                if excluded[side] is not None:
                    reason = OUTSIDE_RADIUS if excluded[side].reason == OUTSIDE_RADIUS else "GEOMETRY_EXCLUDED"
                    uncomparable.append(_uncomparable(building_id, side, reason, excluded[side].message))
                elif present[side] is not None and excluded[other] is not None:
                    uncomparable.append(_uncomparable(
                        building_id, side, "COUNTERPART_EXCLUDED",
                        "다른 분석에서 이 건물의 도형이 제외되어 비교하지 않았습니다."))
            continue
        if kind in ("row", "other"):
            for side, building in present.items():
                if building is not None:
                    uncomparable.append(_uncomparable(
                        building_id, side, "ROW_IDENTIFIER" if kind == "row" else "UNKNOWN_IDENTIFIER",
                        "row: 식별자는 분석마다 바뀌는 순번이므로 같은 ID여도 같은 건물로 보지 않습니다." if kind == "row"
                        else "알 수 없는 형식의 식별자이므로 매칭하지 않았습니다."))
                    pool[side].append(building)
            continue
        b, a = present["BEFORE"], present["AFTER"]
        if b is not None and a is not None:
            same_id.append((building_id, b, a))
            continue
        side, building = ("BEFORE", b) if b is not None else ("AFTER", a)
        changes.append(_one_sided(building_id, side, building, sides[side], basis))
        _flag_repaired(uncomparable, building_id, building.footprint.repaired and side)
        pool[side].append(building)

    if same_id:
        iou, symdiff = _overlap([b for _, b, _ in same_id], [a for _, _, a in same_id])
        for (building_id, b, a), pair_iou, pair_symdiff in zip(same_id, iou, symdiff):
            if _kind(building_id) == "feature" and pair_iou < FEATURE_IOU_THRESHOLD:
                uncomparable.append(_uncomparable(
                    building_id, "BOTH", "FEATURE_ID_UNVERIFIED",
                    f"feature: ID는 같지만 도형 IoU가 {FEATURE_IOU_THRESHOLD} 미만이어서 같은 건물로 보지 않았습니다. "
                    "VWorld 객체 ID가 다른 건물에 다시 부여되었을 수 있습니다.", iou=java_round(pair_iou, 1e6)))
                pool["BEFORE"].append(b)
                pool["AFTER"].append(a)
                continue
            change = _matched(building_id, b, a, b_side, a_side, pair_iou, pair_symdiff)
            changes.append(change)
            repaired = ("BOTH" if b.footprint.repaired and a.footprint.repaired else
                        "BEFORE" if b.footprint.repaired else "AFTER" if a.footprint.repaired else None)
            _flag_repaired(uncomparable, building_id, repaired)

    candidates = _candidates(pool["BEFORE"], pool["AFTER"])
    _building_warnings(warnings, uncomparable, candidates)

    def count(status):
        return sum(1 for c in changes if c.status == status)

    summary = BuildingSummary(
        matched=sum(1 for c in changes if c.match is not None), unchanged=count("UNCHANGED"),
        modified=count("MODIFIED"), added=count("ADDED"), removed=count("REMOVED"),
        only_in_after=count("ONLY_IN_AFTER"), only_in_before=count("ONLY_IN_BEFORE"),
        uncomparable_before=sum(1 for u in uncomparable if u.category == "UNCOMPARABLE" and u.side != "AFTER"),
        uncomparable_after=sum(1 for u in uncomparable if u.category == "UNCOMPARABLE" and u.side != "BEFORE"),
        low_confidence=sum(1 for u in uncomparable if u.category == "LOW_CONFIDENCE"),
        candidates=sum(1 for c in candidates if c.status == "CANDIDATE"),
        ambiguous_candidates=sum(1 for c in candidates if c.status == "AMBIGUOUS"))
    if not request.include_building_changes:
        return BuildingComparison(summary=summary, changes=None, uncomparable=None, possible_same_building=None)
    listed = [c for c in changes if request.include_unchanged or c.status != "UNCHANGED"]
    return BuildingComparison(
        summary=summary,
        changes=sorted(listed, key=lambda c: (_STATUS_ORDER[c.status], c.id)),
        uncomparable=sorted(uncomparable, key=lambda u: (u.id, u.side, u.category)),
        possible_same_building=candidates)


def _state(building: AnalyzedBuilding, side: _Side) -> BuildingState:
    return BuildingState(relation=building.relation, footprint_area=pipeline.area(building.footprint.area),
                         area_in_radius=pipeline.area(building.area_in_radius), floors=building.floors,
                         floors_raw=side.raw_floors.get(building.id), repaired=building.footprint.repaired)


def _one_sided(building_id: str, side: str, building: AnalyzedBuilding, data: _Side, basis: str) -> BuildingChange:
    if basis == CHANGE:
        status = "REMOVED" if side == "BEFORE" else "ADDED"
    else:
        status = "ONLY_IN_BEFORE" if side == "BEFORE" else "ONLY_IN_AFTER"
    state = _state(building, data)
    return BuildingChange(id=building_id, status=status, match=None, changes=[],
                          before=state if side == "BEFORE" else None, after=state if side == "AFTER" else None,
                          footprint_area=None, area_in_radius=None, symmetric_difference_area=None, iou=None,
                          floors=None)


def _matched(building_id: str, b: AnalyzedBuilding, a: AnalyzedBuilding, b_side: _Side, a_side: _Side,
             iou: float, symdiff: float) -> BuildingChange:
    changes = []
    if symdiff >= GEOMETRY_TOLERANCE_M2:
        changes.append("GEOMETRY")
    if b.floors is not None and a.floors is not None and b.floors != a.floors:
        changes.append("FLOORS")
    if (b.floors is None) != (a.floors is None):
        changes.append("FLOORS_DATA")
    if b.relation != a.relation:
        changes.append("RELATION")
    reasons = [f"GEOMETRY_REPAIRED_{side}" for side, x in (("BEFORE", b), ("AFTER", a)) if x.footprint.repaired]
    if reasons:
        confidence = "LOW"
    else:
        confidence = "HIGH" if _kind(building_id) == "bd" else "MEDIUM"
    return BuildingChange(
        id=building_id, status="MODIFIED" if changes else "UNCHANGED",
        match=Match(basis="BD_MGT_SN" if _kind(building_id) == "bd" else "FEATURE_ID_AND_IOU",
                    confidence=confidence, reasons=reasons),
        changes=changes, before=_state(b, b_side), after=_state(a, a_side),
        footprint_area=_metric("m2", b.footprint.area, a.footprint.area, 100),
        area_in_radius=_metric("m2", b.area_in_radius, a.area_in_radius, 100),
        symmetric_difference_area=pipeline.area(symdiff), iou=java_round(iou, 1e6),
        floors=FloorChange(before=b.floors, after=a.floors,
                           delta=a.floors - b.floors if a.floors is not None and b.floors is not None else None,
                           before_raw=b_side.raw_floors.get(building_id),
                           after_raw=a_side.raw_floors.get(building_id)))


def _overlap(before: list[AnalyzedBuilding], after: list[AnalyzedBuilding]) -> tuple[np.ndarray, np.ndarray]:
    """IoU and symmetric difference area of the whole footprints, pairwise."""
    gb = np.array([b.footprint.geometry for b in before], dtype=object)
    ga = np.array([a.footprint.geometry for a in after], dtype=object)
    area_b = np.array([b.footprint.area for b in before])
    area_a = np.array([a.footprint.area for a in after])
    inter = shapely.area(shapely.intersection(gb, ga))
    union = area_b + area_a - inter
    iou = np.divide(inter, union, out=np.zeros_like(union), where=union > 0)
    return iou, np.maximum(area_b + area_a - 2 * inter, 0.0)


def _candidates(before: list[AnalyzedBuilding], after: list[AnalyzedBuilding]) -> list[Candidate]:
    """Pairs of unmatched buildings with IoU >= 0.9. A pair is CANDIDATE only when it is the only such pair of
    both buildings; otherwise every pair of the conflicting buildings is AMBIGUOUS (no 1:1 assignment is made)."""
    if not before or not after:
        return []
    tree = shapely.STRtree(np.array([a.footprint.geometry for a in after], dtype=object))
    bi, ai = tree.query(np.array([b.footprint.geometry for b in before], dtype=object), predicate="intersects")
    if len(bi) == 0:
        return []
    iou, symdiff = _overlap([before[i] for i in bi], [after[i] for i in ai])
    keep = iou >= CANDIDATE_IOU_THRESHOLD
    bi, ai, iou, symdiff = bi[keep], ai[keep], iou[keep], symdiff[keep]
    per_before = np.bincount(bi, minlength=len(before))
    per_after = np.bincount(ai, minlength=len(after))
    result = [Candidate(before_id=before[b].id, after_id=after[a].id, iou=java_round(float(v), 1e6),
                        symmetric_difference_area=pipeline.area(float(s)),
                        status="CANDIDATE" if per_before[b] == 1 and per_after[a] == 1 else "AMBIGUOUS")
              for b, a, v, s in zip(bi, ai, iou, symdiff)]
    return sorted(result, key=lambda c: (-c.iou, c.before_id, c.after_id))


def _uncomparable(building_id: str, side: str, reason: str, message: str, category: str = "UNCOMPARABLE",
                  iou: float | None = None) -> UncomparableBuilding:
    return UncomparableBuilding(id=building_id, side=side, category=category, reason=reason, message=message,
                                iou=iou)


def _flag_repaired(uncomparable: list[UncomparableBuilding], building_id: str, side) -> None:
    if side:
        uncomparable.append(_uncomparable(
            building_id, side, "GEOMETRY_REPAIRED",
            "유효하지 않은 도형을 복구해 비교했습니다. 면적·도형 변화는 복구 결과에 따라 달라질 수 있습니다.",
            category="LOW_CONFIDENCE"))


def _building_warnings(warnings: list[StatWarning], uncomparable: list[UncomparableBuilding],
                       candidates: list[Candidate]) -> None:
    def reasons(*codes):
        return sum(1 for u in uncomparable if u.reason in codes)

    pipeline.warn(warnings, "ROW_IDENTIFIERS", reasons("ROW_IDENTIFIER", "UNKNOWN_IDENTIFIER"),
                  "row: 등 안정적이지 않은 식별자의 건물은 매칭하지 않았습니다(buildings.uncomparable).")
    pipeline.warn(warnings, "FEATURE_ID_UNVERIFIED", reasons("FEATURE_ID_UNVERIFIED"),
                  f"feature: ID가 같지만 도형 IoU가 {FEATURE_IOU_THRESHOLD} 미만인 건물은 같은 건물로 보지 않았습니다.")
    pipeline.warn(warnings, "GEOMETRY_EXCLUDED", reasons("GEOMETRY_EXCLUDED", "OUTSIDE_RADIUS", "COUNTERPART_EXCLUDED"),
                  "어느 한쪽에서 도형이 제외된 건물은 비교하지 않았습니다(buildings.uncomparable).")
    pipeline.warn(warnings, "LOW_CONFIDENCE", reasons("GEOMETRY_REPAIRED"),
                  "도형을 복구한 건물이 있습니다. 해당 건물의 비교 신뢰도는 낮습니다(match.confidence=LOW).")
    pipeline.warn(warnings, "POSSIBLE_SAME_BUILDING", sum(1 for c in candidates if c.status == "CANDIDATE"),
                  "식별자는 다르지만 도형이 거의 같은 건물 쌍이 있습니다. 후보일 뿐이며 추가·삭제 판정에는 반영하지 "
                  "않았습니다(buildings.possibleSameBuilding).")
    pipeline.warn(warnings, "AMBIGUOUS_CANDIDATES", sum(1 for c in candidates if c.status == "AMBIGUOUS"),
                  "한 건물에 동일 건물 후보가 여러 개 있어 1:1로 대응시키지 않았습니다.")


def _notes(basis: str) -> list[Note]:
    notes = [
        Note(targets=["statistics", "buildings"],
             message="변화는 두 분석 시점의 VWorld LT_C_SPBD(도로명주소 건물) 데이터 차이입니다. VWorld 데이터 갱신 시점은 "
                     "실제 신축·철거·증축 시점과 다를 수 있으므로 실제 건물 변경 시점으로 표시하지 마세요."),
        Note(targets=["buildings.changes"],
             message="ADDED/REMOVED는 데이터에 건물이 나타나거나 사라졌다는 뜻이며 신축·철거를 확인한 것이 아닙니다. "
                     "건물관리번호가 바뀐 건물도 추가와 삭제로 나타날 수 있습니다(possibleSameBuilding 참고)."),
        Note(targets=["buildings.possibleSameBuilding"],
             message="도형이 거의 같은 다른 식별자의 건물 쌍입니다. 확정된 대응이 아니며 상태와 통계에 반영하지 않았습니다."),
        Note(targets=["statistics.unionArea", "statistics.sumArea", "statistics.averageArea"],
             message="면적은 VWorld 도형의 수평 면적(m²)이며 건축물대장의 건축면적이나 연면적과 다를 수 있습니다."),
    ]
    if basis == OBSERVATION:
        notes.append(Note(
            targets=["statistics", "buildings.summary", "buildings.changes"],
            message="한쪽 이상이 부분 조회 결과이므로 모든 차이는 관측 데이터의 차이(OBSERVATION_DIFFERENCE)입니다. 지역 전체의 "
                    "건물 변화나 밀집도 변화로 표시하지 마세요."))
    return notes
