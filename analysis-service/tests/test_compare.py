import time

import pytest
from pydantic import ValidationError

from app.schemas.building_stats import BuildingStatsRequest
from app.schemas.compare import CompareRequest
from app.services.building_stats import compute_building_stats
from app.services.compare import compare_analyses
from tests.factories import PROJECTION, building, polygon, rect, request, ring
from tests.java_result import to_compare_request

DATA_SOURCE = {"provider": "VWorld 2D 데이터 API", "layer": "LT_C_SPBD (도로명주소 건물)",
               "coordinateSystem": "EPSG:4326 (WGS84 경위도)"}
BEFORE_AT = "2026-03-01T09:00:00Z"
AFTER_AT = "2026-09-01T09:00:00Z"


def saved(buildings, analysis_id=1, analyzed_at=BEFORE_AT, **extra) -> dict:
    fields = {"source": {"kind": "SAVED", "analysisId": analysis_id, "analyzedAt": analyzed_at},
              "criterion": "POLYGON_INTERSECTS_CIRCLE", "dataSource": dict(DATA_SOURCE), **extra}
    return request(buildings, **fields)


def payload(before_buildings, after_buildings, before=None, after=None, **options) -> dict:
    return {"before": saved(before_buildings, 1, BEFORE_AT, **(before or {})),
            "after": saved(after_buildings, 2, AFTER_AT, **(after or {})), **options}


def compare(data: dict):
    return compare_analyses(CompareRequest.model_validate(data))


def change(result, building_id):
    return next(c for c in result.buildings.changes if c.id == building_id)


def uncomparable(result, building_id):
    return [(u.side, u.category, u.reason) for u in result.buildings.uncomparable if u.id == building_id]


def codes(result) -> set[str]:
    return {w.code for w in result.warnings}


def square(building_id, x, y=0.0, size=10.0, floors="3"):
    return building(building_id, polygon(rect(x, y, x + size, y + size)), floors=floors)


# ----------------------------------------------------------------------------------------- statistics

def test_same_content_in_two_analyses():
    buildings = [square(f"bd:{i}", i * 15) for i in range(5)] + [square("feature:LT_C_SPBD.7", -40)]
    result = compare(payload(buildings, buildings, includeUnchanged=True))
    s = result.statistics

    assert result.comparable and result.comparison_basis == "CHANGE" and result.not_comparable_reasons == []
    for metric in (s.building_count, s.union_area, s.sum_area, s.coverage_ratio, s.average_area, s.average_floors):
        assert metric.delta == 0 and metric.change_rate == 0
    assert s.coverage_ratio.delta_percent_point == 0
    assert result.buildings.summary.matched == 6 and result.buildings.summary.unchanged == 6
    assert {c.status for c in result.buildings.changes} == {"UNCHANGED"}
    assert change(result, "bd:0").match.confidence == "HIGH" and change(result, "bd:0").iou == 1
    assert change(result, "feature:LT_C_SPBD.7").match.basis == "FEATURE_ID_AND_IOU"
    assert change(result, "feature:LT_C_SPBD.7").match.confidence == "MEDIUM"
    assert result.buildings.uncomparable == [] and result.buildings.possible_same_building == []


def test_unchanged_buildings_are_left_out_by_default():
    buildings = [square("bd:1", 0), square("bd:2", 20)]
    result = compare(payload(buildings, [square("bd:1", 0), square("bd:2", 20, floors="4")]))

    assert [c.id for c in result.buildings.changes] == ["bd:2"]
    assert result.buildings.summary.unchanged == 1 and result.buildings.summary.modified == 1


def test_statistics_match_building_stats_of_each_side():
    before = [square("bd:1", 0, floors="2"), square("bd:2", 5, floors="4"), square("bd:3", 90, size=20)]
    after = [square("bd:1", 0, floors="3"), square("bd:4", 40, size=20, floors=None)]
    data = payload(before, after)
    result = compare(data)
    s = result.statistics

    for side, metric_side in (("before", "before"), ("after", "after")):
        stats = compute_building_stats(BuildingStatsRequest.model_validate(
            {k: v for k, v in data[side].items() if k not in ("criterion", "dataSource")}))
        assert getattr(s.building_count, metric_side) == stats.counts.analyzed
        assert getattr(s.union_area, metric_side) == stats.within_radius.union_area
        assert getattr(s.sum_area, metric_side) == stats.footprint.sum_area
        assert getattr(s.coverage_ratio, metric_side) == stats.within_radius.coverage_ratio
        assert getattr(s.average_area, metric_side) == stats.footprint.average_area
        assert getattr(s.floors_with_data, metric_side) == stats.floors.with_data
    assert s.average_floors.before == 3 and s.average_floors.after == 3
    assert s.building_count.delta == -1 and s.building_count.change_rate == pytest.approx(-1 / 3, abs=1e-6)
    # Before: 100 + 100 - 50 (overlap) + 20x20 crossing r = 100 (part inside); after: 100 + 400.
    assert s.union_area.delta == pytest.approx(s.union_area.after - s.union_area.before, abs=0.011)
    assert s.coverage_ratio.delta_percent_point == pytest.approx(s.coverage_ratio.delta * 100, abs=1e-3)


def test_change_rate_is_null_when_before_is_zero():
    result = compare(payload([], [square("bd:1", 0)]))
    s = result.statistics

    assert s.building_count.before == 0 and s.building_count.after == 1 and s.building_count.delta == 1
    assert s.building_count.change_rate is None and s.union_area.change_rate is None
    assert s.average_area.before is None and s.average_area.delta is None and s.average_area.change_rate is None
    assert s.average_floors.before is None and s.average_floors.change_rate is None


def test_statistics_are_computed_before_rounding():
    # 0.004 m² differences: rounded areas would hide the change, the delta still shows it.
    before = [building("bd:1", polygon(rect(0, 0, 10, 10)))]
    after = [building("bd:1", polygon(rect(0, 0, 10.0004, 10)))]
    s = compare(payload(before, after)).statistics

    assert s.union_area.before == 100.0 and s.union_area.after == 100.0
    assert s.union_area.delta == 0.0  # 0.004 rounds to 0.00
    assert s.coverage_ratio.delta_percent_point == pytest.approx(0.004 / 31415.93 * 100, abs=1e-4)


def test_java_building_count_needs_both_summaries():
    summary = {"intersecting": 3, "inside": 3, "partial": 0, "outsideExcluded": 0, "geometryUnavailable": 0,
               "distinctBuildings": 3, "mergedDuplicateFeatures": 0}
    with_both = compare(payload([square("bd:1", 0)], [square("bd:1", 0)], before={"javaSummary": summary},
                                after={"javaSummary": {**summary, "intersecting": 5}}))
    with_one = compare(payload([square("bd:1", 0)], [square("bd:1", 0)], before={"javaSummary": summary}))

    assert with_both.statistics.java_building_count.delta == 2
    assert with_one.statistics.java_building_count is None


# ----------------------------------------------------------------------------------------- buildings

def test_added_and_removed_buildings():
    result = compare(payload([square("bd:1", 0), square("bd:2", 20)], [square("bd:1", 0), square("bd:3", 40)]))
    added, removed = change(result, "bd:3"), change(result, "bd:2")

    assert added.status == "ADDED" and added.before is None and added.after.footprint_area == 100
    assert removed.status == "REMOVED" and removed.after is None and removed.match is None
    assert result.buildings.summary.added == 1 and result.buildings.summary.removed == 1
    assert [c.status for c in result.buildings.changes] == ["ADDED", "REMOVED"]


def test_area_change_of_the_same_building():
    result = compare(payload([square("bd:1", 0)], [building("bd:1", polygon(rect(0, 0, 12, 10)))]))
    c = change(result, "bd:1")

    assert c.status == "MODIFIED" and c.changes == ["GEOMETRY"]
    assert c.footprint_area.before == 100 and c.footprint_area.after == 120
    assert c.footprint_area.delta == 20 and c.footprint_area.change_rate == 0.2
    assert c.symmetric_difference_area == 20 and c.iou == pytest.approx(100 / 120, abs=1e-6)
    assert c.area_in_radius.delta == 20


def test_moved_footprint_with_the_same_area_is_a_geometry_change():
    c = change(compare(payload([square("bd:1", 0)], [square("bd:1", 5)])), "bd:1")

    assert c.changes == ["GEOMETRY"] and c.footprint_area.delta == 0
    assert c.symmetric_difference_area == 100 and c.iou == pytest.approx(50 / 150, abs=1e-6)


def test_differences_below_the_geometry_tolerance_are_unchanged():
    result = compare(payload([square("bd:1", 0)], [building("bd:1", polygon(rect(0, 0, 10.0005, 10)))],
                             includeUnchanged=True))

    assert change(result, "bd:1").status == "UNCHANGED"
    assert change(result, "bd:1").symmetric_difference_area == pytest.approx(0.005, abs=0.01)


@pytest.mark.parametrize(("before", "after", "changes", "delta"), [
    ("3", "5", ["FLOORS"], 2), ("5", "3", ["FLOORS"], -2), ("3", None, ["FLOORS_DATA"], None),
    ("0", "4", ["FLOORS_DATA"], None), ("0", "abc", [], None), ("3", "3", [], 0)])
def test_floor_changes(before, after, changes, delta):
    result = compare(payload([square("bd:1", 0, floors=before)], [square("bd:1", 0, floors=after)],
                             includeUnchanged=True))
    c = change(result, "bd:1")

    assert c.changes == changes and c.status == ("MODIFIED" if changes else "UNCHANGED")
    assert c.floors.delta == delta
    assert c.floors.before_raw == before and c.floors.after_raw == after


def test_relation_change_inside_to_partial():
    c = change(compare(payload([building("bd:1", polygon(rect(80, -5, 95, 5)))],
                               [building("bd:1", polygon(rect(80, -5, 105, 5)))])), "bd:1")

    assert c.changes == ["GEOMETRY", "RELATION"]
    assert c.before.relation == "INSIDE" and c.after.relation == "PARTIAL"
    assert c.area_in_radius.delta < c.footprint_area.delta


# ----------------------------------------------------------------------------------------- identifiers

@pytest.mark.parametrize(("shift", "matched"), [(0, True), (3.3, True), (3.4, False), (30, False)])
def test_feature_id_needs_iou_of_at_least_half(shift, matched):
    # IoU of two 10 m squares shifted by s: (10 - s) / (10 + s); 0.5 at s = 3.33.
    fid = "feature:LT_C_SPBD.1110133463"
    result = compare(payload([square(fid, 0)], [square(fid, shift)], includeUnchanged=True))

    if matched:
        c = change(result, fid)
        assert c.match.basis == "FEATURE_ID_AND_IOU" and c.match.confidence == "MEDIUM"
        assert c.iou == pytest.approx((10 - shift) / (10 + shift), abs=1e-6)
        assert uncomparable(result, fid) == []
    else:
        assert all(c.id != fid for c in result.buildings.changes)
        assert uncomparable(result, fid) == [("BOTH", "UNCOMPARABLE", "FEATURE_ID_UNVERIFIED")]
        entry = next(u for u in result.buildings.uncomparable if u.id == fid)
        assert entry.iou == pytest.approx((10 - shift) / (10 + shift) if shift < 10 else 0, abs=1e-6)
        assert result.buildings.summary.added == 0 and result.buildings.summary.removed == 0
        assert result.buildings.summary.uncomparable_before == 1 and result.buildings.summary.uncomparable_after == 1
        assert "FEATURE_ID_UNVERIFIED" in codes(result)


def test_row_ids_are_never_matched_even_when_equal():
    result = compare(payload([square("row:0", 0), square("bd:1", 30)], [square("row:0", 0), square("bd:1", 30)],
                             includeUnchanged=True))

    assert [c.id for c in result.buildings.changes] == ["bd:1"]
    assert uncomparable(result, "row:0") == [("AFTER", "UNCOMPARABLE", "ROW_IDENTIFIER"),
                                             ("BEFORE", "UNCOMPARABLE", "ROW_IDENTIFIER")]
    summary = result.buildings.summary
    assert summary.matched == 1 and summary.added == 0 and summary.removed == 0
    # The same footprint is only a candidate.
    assert [(c.before_id, c.after_id, c.status) for c in result.buildings.possible_same_building] == [
        ("row:0", "row:0", "CANDIDATE")]
    assert "ROW_IDENTIFIERS" in codes(result)
    assert result.before.identifiers.row == 1 and result.before.identifiers.bd == 1


def test_unknown_identifier_kind_is_not_matched():
    result = compare(payload([square("x:1", 0)], [square("x:1", 0)]))

    assert uncomparable(result, "x:1") == [("AFTER", "UNCOMPARABLE", "UNKNOWN_IDENTIFIER"),
                                           ("BEFORE", "UNCOMPARABLE", "UNKNOWN_IDENTIFIER")]
    assert result.before.identifiers.other == 1


@pytest.mark.parametrize(("shift", "candidate"), [(0, True), (0.5, True), (0.6, False)])
def test_changed_id_is_only_a_candidate_from_iou_0_9(shift, candidate):
    # (10 - s) / (10 + s): 0.905 at s = 0.5, 0.887 at s = 0.6.
    result = compare(payload([square("bd:1", 0)], [square("bd:2", shift)]))

    assert change(result, "bd:1").status == "REMOVED" and change(result, "bd:2").status == "ADDED"
    pairs = [(c.before_id, c.after_id, c.status) for c in result.buildings.possible_same_building]
    assert pairs == ([("bd:1", "bd:2", "CANDIDATE")] if candidate else [])
    assert result.buildings.summary.candidates == int(candidate)
    if candidate:
        c = result.buildings.possible_same_building[0]
        assert c.iou == pytest.approx((10 - shift) / (10 + shift), abs=1e-6)
        assert c.symmetric_difference_area == pytest.approx(2 * shift * 10, abs=0.01)


def test_conflicting_candidates_are_ambiguous_and_never_paired():
    # bd:1 has two equally good partners (bd:8 and bd:9 duplicate each other); bd:2 -> bd:7 is unique.
    result = compare(payload([square("bd:1", 0), square("bd:2", 40)],
                             [square("bd:8", 0), square("bd:9", 0), square("bd:7", 40.2)]))
    pairs = {(c.before_id, c.after_id): c.status for c in result.buildings.possible_same_building}

    assert pairs == {("bd:1", "bd:8"): "AMBIGUOUS", ("bd:1", "bd:9"): "AMBIGUOUS", ("bd:2", "bd:7"): "CANDIDATE"}
    summary = result.buildings.summary
    assert summary.candidates == 1 and summary.ambiguous_candidates == 2
    assert summary.added == 3 and summary.removed == 2 and summary.matched == 0
    assert {"POSSIBLE_SAME_BUILDING", "AMBIGUOUS_CANDIDATES"} <= codes(result)


def test_conflict_on_the_before_side():
    result = compare(payload([square("bd:1", 0), square("bd:2", 0)], [square("bd:3", 0)]))

    assert {c.status for c in result.buildings.possible_same_building} == {"AMBIGUOUS"}
    assert len(result.buildings.possible_same_building) == 2


def test_matched_buildings_are_not_candidates():
    # bd:1 is matched by id; bd:2 (removed) overlaps bd:1's new footprint but bd:1 is not in the pool.
    result = compare(payload([square("bd:1", 0), square("bd:2", 50)], [square("bd:1", 50)]))

    assert change(result, "bd:1").status == "MODIFIED"
    assert result.buildings.possible_same_building == []


# ----------------------------------------------------------------------------------------- conditions

@pytest.mark.parametrize(("offset", "comparable"), [(0.0, True), (0.049, True), (0.051, False), (5.0, False)])
def test_center_tolerance(offset, comparable):
    center = {"lon": PROJECTION.lon(offset), "lat": PROJECTION.lat(0.0)}
    result = compare(payload([square("bd:1", 0)], [square("bd:1", 0)], after={"center": center}))

    assert result.comparable is comparable
    assert result.conditions.center_distance_meters == pytest.approx(offset, abs=1e-4)
    assert result.conditions.same_center is comparable
    if not comparable:
        assert [r.code for r in result.not_comparable_reasons] == ["CENTER_DIFFERENT"]
        assert result.statistics is None and result.buildings is None and result.method.analysis is None
        # Each side is still described.
        assert result.before.counts.analyzed == 1 and result.after.counts.analyzed == 1


def test_center_tolerance_north_south():
    center = {"lon": PROJECTION.lon(0.0), "lat": PROJECTION.lat(0.051)}

    assert not compare(payload([], [], after={"center": center})).comparable


def test_radius_must_be_equal():
    result = compare(payload([square("bd:1", 0)], [square("bd:1", 0)], after={"radiusMeters": 101}))

    assert not result.comparable and [r.code for r in result.not_comparable_reasons] == ["RADIUS_DIFFERENT"]
    assert not result.conditions.same_radius


@pytest.mark.parametrize(("after", "code"), [
    ({"criterion": "POLYGON_CENTROID_IN_CIRCLE"}, "CRITERION_DIFFERENT"),
    ({"dataSource": {**DATA_SOURCE, "layer": "LT_C_BLDGINFO"}}, "DATA_SOURCE_DIFFERENT"),
    ({"dataSource": {**DATA_SOURCE, "provider": "other"}}, "DATA_SOURCE_DIFFERENT"),
    ({"dataSource": {**DATA_SOURCE, "coordinateSystem": "EPSG:5186"}}, "COORDINATE_SYSTEM_DIFFERENT")])
def test_method_and_source_must_match(after, code):
    result = compare(payload([], [], after=after))

    assert not result.comparable and [r.code for r in result.not_comparable_reasons] == [code]


def test_unsupported_criterion_on_both_sides():
    result = compare(payload([], [], before={"criterion": "OTHER"}, after={"criterion": "OTHER"}))

    assert [r.code for r in result.not_comparable_reasons] == ["CRITERION_UNSUPPORTED"]


def test_several_reasons_are_all_reported():
    center = {"lon": PROJECTION.lon(100.0), "lat": PROJECTION.lat(0.0)}
    result = compare(payload([], [], after={"center": center, "radiusMeters": 200}))

    assert [r.code for r in result.not_comparable_reasons] == ["CENTER_DIFFERENT", "RADIUS_DIFFERENT"]


def test_reversed_order_is_rejected():
    data = payload([], [])
    data["before"]["source"]["analyzedAt"] = "2026-09-02T00:00:00Z"
    with pytest.raises(ValidationError) as error:
        CompareRequest.model_validate(data)

    assert error.value.errors()[0]["type"] == "analysis_order_reversed"


def test_same_analysis_id_is_rejected():
    data = payload([], [])
    data["after"]["source"]["analysisId"] = 1
    with pytest.raises(ValidationError) as error:
        CompareRequest.model_validate(data)

    assert error.value.errors()[0]["type"] == "same_analysis"


def test_same_time_with_different_ids_is_allowed_with_a_warning():
    data = payload([square("bd:1", 0)], [square("bd:1", 0)])
    data["after"]["source"]["analyzedAt"] = BEFORE_AT
    result = compare(data)

    assert result.comparable and result.conditions.analyzed_interval_seconds == 0
    assert "SAME_ANALYZED_AT" in codes(result)


@pytest.mark.parametrize(("source", "error"), [
    ({"kind": "LIVE", "analyzedAt": BEFORE_AT}, "saved_analysis_required"),
    ({"kind": "SAVED", "analysisId": 1}, "analyzed_at_required"),
    ({"kind": "SAVED", "analysisId": 1, "analyzedAt": "2026-03-01T09:00:00"}, "analyzed_at_required")])
def test_saved_source_with_time_zone_is_required(source, error):
    data = payload([], [])
    data["before"]["source"] = source
    with pytest.raises(ValidationError) as raised:
        CompareRequest.model_validate(data)

    assert error in {e["type"] for e in raised.value.errors()}


def test_time_zones_are_compared_as_instants():
    data = payload([], [])
    data["before"]["source"]["analyzedAt"] = "2026-09-01T17:00:00+09:00"  # 08:00Z, an hour before after
    result = compare(data)

    assert result.conditions.analyzed_interval_seconds == 3600


# ----------------------------------------------------------------------------------------- completeness

def test_partial_result_is_an_observation_difference():
    result = compare(payload([square("bd:1", 0), square("bd:2", 20)], [square("bd:1", 0), square("bd:3", 40)],
                             after={"complete": False,
                                    "incompleteReasons": [{"code": "PAGE_LIMIT", "message": "조회 한도"}]}))

    assert result.comparable and result.comparison_basis == "OBSERVATION_DIFFERENCE"
    assert result.statistics.basis == "OBSERVATION_DIFFERENCE"
    assert change(result, "bd:3").status == "ONLY_IN_AFTER" and change(result, "bd:2").status == "ONLY_IN_BEFORE"
    summary = result.buildings.summary
    assert summary.added == 0 and summary.removed == 0
    assert summary.only_in_after == 1 and summary.only_in_before == 1
    assert result.warnings[0].code == "OBSERVATION_DIFFERENCE"
    assert any("OBSERVATION_DIFFERENCE" in n.message for n in result.notes)
    assert [w.code for w in result.after.warnings][0] == "PARTIAL_RESULT"
    assert not result.conditions.both_complete


@pytest.mark.parametrize("side", ["before", "after"])
def test_either_side_partial(side):
    reasons = {"complete": False, "incompleteReasons": [{"code": "TIME_LIMIT", "message": "x"}]}
    result = compare(payload([], [], **{side: reasons}))

    assert result.comparison_basis == "OBSERVATION_DIFFERENCE"


def test_messages_never_claim_construction_or_demolition():
    result = compare(payload([square("bd:1", 0)], [square("bd:2", 30)]))
    text = " ".join([n.message for n in result.notes] + [w.message for w in result.warnings]
                    + [result.statistics.interpretation])

    assert "VWorld 데이터 갱신 시점" in text
    assert "신축·철거를 확인한 것이 아닙니다" in text


# ----------------------------------------------------------------------------------------- geometry

def test_repaired_and_excluded_geometry():
    bowtie = polygon(ring([(0, 0), (10, 10), (10, 0), (0, 10)]))
    collapsed = polygon(ring([(30, 0), (40, 0), (50, 0)]))
    result = compare(payload([square("bd:1", 0), square("bd:2", 30), square("bd:3", 60)],
                             [building("bd:1", bowtie), building("bd:2", collapsed), square("bd:3", 60)],
                             includeUnchanged=True))

    repaired = change(result, "bd:1")
    assert repaired.match.confidence == "LOW" and repaired.match.reasons == ["GEOMETRY_REPAIRED_AFTER"]
    assert repaired.after.repaired and repaired.after.footprint_area == pytest.approx(50, abs=0.01)
    assert uncomparable(result, "bd:1") == [("AFTER", "LOW_CONFIDENCE", "GEOMETRY_REPAIRED")]
    assert uncomparable(result, "bd:2") == [("AFTER", "UNCOMPARABLE", "GEOMETRY_EXCLUDED"),
                                            ("BEFORE", "UNCOMPARABLE", "COUNTERPART_EXCLUDED")]
    assert all(c.id != "bd:2" for c in result.buildings.changes)
    assert change(result, "bd:3").match.confidence == "HIGH"
    summary = result.buildings.summary
    assert summary.removed == 0 and summary.low_confidence == 1
    assert summary.uncomparable_before == 1 and summary.uncomparable_after == 1
    assert {"LOW_CONFIDENCE", "GEOMETRY_EXCLUDED"} <= codes(result)
    assert result.after.counts.repaired == 1 and result.after.counts.excluded == 1


def test_outside_radius_building_is_uncomparable():
    result = compare(payload([square("bd:1", 0)], [square("bd:1", 0), square("bd:2", 200)]))

    assert uncomparable(result, "bd:2") == [("AFTER", "UNCOMPARABLE", "OUTSIDE_RADIUS")]
    assert result.buildings.summary.added == 0


def test_building_lists_can_be_left_out():
    result = compare(payload([square("bd:1", 0)], [square("bd:2", 0)], includeBuildingChanges=False))

    assert result.buildings.summary.added == 1 and result.buildings.summary.candidates == 1
    assert result.buildings.changes is None and result.buildings.uncomparable is None
    assert result.buildings.possible_same_building is None


def test_result_is_deterministic():
    data = payload([square(f"bd:{i}", i * 12, floors=str(i)) for i in range(20)],
                   [square(f"bd:{i}", i * 12 + (i % 3), floors=str(i + i % 2)) for i in range(5, 25)])

    assert compare(data).model_dump() == compare(data).model_dump()


def test_java_saved_details_map_to_a_compare_request():
    def detail(analysis_id, analyzed_at, buildings):
        return {"analysisId": analysis_id, "title": "t", "analyzedAt": analyzed_at, "savedAt": analyzed_at,
                "result": {"center": {"lon": 127.0, "lat": 37.5}, "radiusMeters": 100,
                           "criterion": "POLYGON_INTERSECTS_CIRCLE", "complete": True, "incompleteReasons": [],
                           "summary": {"intersecting": len(buildings), "inside": len(buildings), "partial": 0,
                                       "outsideExcluded": 0, "geometryUnavailable": 0,
                                       "distinctBuildings": len(buildings), "mergedDuplicateFeatures": 0},
                           "source": {**DATA_SOURCE, "notice": "..."},
                           "buildings": [{"id": b["id"], "building": {"groundFloorCount": b["groundFloorRaw"]},
                                          "relation": "INSIDE", "distanceMeters": 0.0,
                                          "polygons": [b["geometry"]["coordinates"]]} for b in buildings]}}

    data = to_compare_request(detail(12, BEFORE_AT, [square("bd:1", 0)]),
                              detail(15, AFTER_AT, [square("bd:1", 0, floors="4")]))
    result = compare(data)

    assert result.before.source.analysis_id == 12 and result.after.source.analysis_id == 15
    assert result.statistics.java_building_count.delta == 0
    assert change(result, "bd:1").changes == ["FLOORS"]


# ----------------------------------------------------------------------------------------- performance

def city(seed_shift: int) -> list[dict]:
    """5000 buildings over a 1 km radius; seed_shift moves, removes, adds and renumbers some of them."""
    buildings = []
    for i in range(5000):
        x = -1050 + (i % 75) * 28.0
        y = -1050 + (i // 75) * 28.0 + (i % 3)
        width = 20 + (i % 7) + (1.5 if seed_shift and i % 11 == 0 else 0)
        floors = str(i % 30 + (1 if seed_shift and i % 13 == 0 else 0))
        building_id = f"bd:{i:05d}" if not (seed_shift and i % 97 == 0) else f"bd:new{i:05d}"
        buildings.append(building(building_id, polygon(rect(x, y, x + width, y + 15)), floors=floors))
    return buildings


def test_5000_buildings_twice(record_property):
    data = payload(city(0), city(1), before={"radius": 1000}, after={"radius": 1000})

    started = time.perf_counter()
    model = CompareRequest.model_validate(data)
    validated = time.perf_counter()
    result = compare_analyses(model)
    finished = time.perf_counter()
    record_property("validate_seconds", round(validated - started, 3))
    record_property("compute_seconds", round(finished - validated, 3))
    s = result.buildings.summary
    print(f"\n5000 x 2 compare: validate {validated - started:.3f}s, compute {finished - validated:.3f}s; "
          f"matched {s.matched}, modified {s.modified}, added {s.added}, removed {s.removed}, "
          f"candidates {s.candidates}")

    assert result.comparable and result.before.counts.total == 5000 and result.after.counts.total == 5000
    assert s.added == s.removed and s.candidates > 0 and s.ambiguous_candidates == 0
    assert s.modified > 0 and s.matched + s.removed == result.before.counts.analyzed
    assert finished - started < 10
