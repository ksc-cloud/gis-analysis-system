import math
import time

import pytest

from app.schemas.building_stats import BuildingStatsRequest
from app.services.building_stats import compute_building_stats
from tests.factories import building, multipolygon, polygon, rect, rect_in_disk_area, request, ring


def stats(payload: dict):
    return compute_building_stats(BuildingStatsRequest.model_validate(payload))


def codes(result) -> set[str]:
    return {w.code for w in result.warnings}


def test_empty_radius():
    result = stats(request([]))

    assert result.counts.total == 0 and result.counts.analyzed == 0
    assert result.footprint.sum_area == 0 and result.footprint.union_area == 0
    assert result.footprint.average_area is None and result.footprint.median_area is None
    assert result.within_radius.union_area == 0 and result.within_radius.coverage_ratio == 0
    assert result.floors.with_data == 0 and result.floors.average is None
    assert result.warnings == [] and result.excluded == []
    assert result.completeness.scope == "COMPLETE_RESULT"


def test_building_inside_radius():
    result = stats(request([building("bd:1", polygon(rect(10, -5, 30, 5)), floors="4")]))
    b = result.buildings[0]

    assert result.counts.inside == 1 and result.counts.partial == 0
    assert b.footprint_area == pytest.approx(200, abs=0.01)
    assert b.area_in_radius == b.footprint_area
    assert b.distance_meters == 10 and b.relation == "INSIDE"
    assert result.within_radius.coverage_ratio == pytest.approx(200 / (math.pi * 100 ** 2), abs=1e-6)
    assert result.floors.average == 4.0


@pytest.mark.parametrize(("radius", "x0", "x1", "h"), [
    (100, 90, 110, 10), (100, 95, 140, 30), (200, 150, 260, 40), (1000, 990, 1010, 10), (50, 0, 80, 20)])
def test_building_crossing_the_boundary(radius, x0, x1, h):
    result = stats(request([building("bd:1", polygon(rect(x0, -h, x1, h)))], radius=radius))
    exact = rect_in_disk_area(radius, x0, x1, h)
    b = result.buildings[0]

    assert b.relation == "PARTIAL"
    assert b.footprint_area == pytest.approx((x1 - x0) * 2 * h, abs=0.01)
    # The 256-gon only removes area: never more, and less by at most the gap between circle and polygon.
    assert b.area_in_radius <= exact + 0.01
    assert exact - b.area_in_radius <= result.method.circle_missing_area
    # Per building the loss is at most the radial gap along the part of the circle inside the building.
    assert exact - b.area_in_radius <= result.method.circle_max_radial_gap_meters * 2 * h + 0.01


def test_building_touching_the_boundary_is_counted_with_zero_area():
    result = stats(request([building("bd:1", polygon(rect(100, -5, 110, 5)))], radius=100))

    assert result.counts.analyzed == 1 and result.counts.partial == 1
    assert result.counts.zero_area_in_radius == 1
    assert result.buildings[0].area_in_radius == 0
    assert result.within_radius.union_area == 0


def test_building_beyond_tolerance_is_excluded_as_outside():
    result = stats(request([building("bd:1", polygon(rect(100.01, -5, 110, 5)))], radius=100))

    assert result.counts.analyzed == 0 and result.counts.excluded == 1
    assert result.excluded[0].reason == "OUTSIDE_RADIUS"
    assert "OUTSIDE_RADIUS" in codes(result)


def test_overlapping_buildings_sum_versus_union():
    result = stats(request([building("bd:1", polygon(rect(0, 0, 10, 10))),
                            building("bd:2", polygon(rect(5, 0, 15, 10)))]))

    assert result.footprint.sum_area == pytest.approx(200, abs=0.01)
    assert result.footprint.union_area == pytest.approx(150, abs=0.01)
    assert result.footprint.between_building_overlap_area == pytest.approx(50, abs=0.01)
    assert result.footprint.internal_overlap_area == 0
    assert result.within_radius.union_area == pytest.approx(150, abs=0.01)
    assert result.within_radius.coverage_ratio == pytest.approx(150 / (math.pi * 100 ** 2), abs=1e-6)
    assert "BETWEEN_BUILDING_OVERLAP" in codes(result)


def test_multipolygon_internal_overlap_is_separate_from_between_building_overlap():
    merged = multipolygon([rect(0, 0, 10, 10)], [rect(5, 0, 15, 10)])
    result = stats(request([building("bd:1", merged), building("bd:2", polygon(rect(40, 0, 50, 10)))]))
    b1 = next(b for b in result.buildings if b.id == "bd:1")

    assert b1.footprint_area == pytest.approx(150, abs=0.01)
    assert b1.internal_overlap_area == pytest.approx(50, abs=0.01)
    assert result.footprint.internal_overlap_area == pytest.approx(50, abs=0.01)
    assert result.footprint.sum_area == pytest.approx(250, abs=0.01)
    assert result.footprint.between_building_overlap_area == 0
    assert result.counts.multi_part_overlap == 1
    assert {"MULTI_PART_OVERLAP"} <= codes(result) and "BETWEEN_BUILDING_OVERLAP" not in codes(result)


def test_polygon_with_hole():
    geometry = polygon(rect(-30, -30, 30, 30), ring([(-10, -10), (-10, 10), (10, 10), (10, -10)]))
    result = stats(request([building("bd:1", geometry)], radius=50))
    b = result.buildings[0]

    assert b.footprint_area == pytest.approx(3600 - 400, abs=0.01)
    assert b.center_inside is False and b.distance_meters == 10
    assert b.relation == "INSIDE"


def test_invalid_geometry_is_repaired_or_excluded():
    bowtie = polygon(ring([(0, 0), (10, 10), (10, 0), (0, 10)]))
    collapsed = polygon(ring([(0, 0), (10, 0), (20, 0)]))
    result = stats(request([building("bd:1", bowtie), building("bd:2", collapsed),
                            building("bd:3", polygon(rect(20, 20, 30, 30)))]))

    assert result.counts.total == 3
    assert result.counts.valid_geometry == 2 and result.counts.analyzed == 2
    assert result.counts.repaired == 1 and result.counts.excluded == 1
    assert result.excluded[0].id == "bd:2" and result.excluded[0].reason == "INVALID_GEOMETRY"
    bowtie_result = next(b for b in result.buildings if b.id == "bd:1")
    assert bowtie_result.repaired and bowtie_result.repair_reasons == ["Self-intersection"]
    assert bowtie_result.footprint_area == pytest.approx(50, abs=0.01)
    assert {"GEOMETRY_REPAIRED", "GEOMETRY_EXCLUDED"} <= codes(result)
    assert any("counts.analyzed" in n.targets for n in result.completeness.notes)


def test_missing_floors():
    floors = ["5", None, "0", "abc", "2"]
    result = stats(request([building(f"bd:{i}", polygon(rect(i * 20, 0, i * 20 + 10, 10)), floors=f)
                            for i, f in enumerate(floors)]))

    assert result.floors.with_data == 2 and result.floors.without_data == 3
    assert result.floors.min == 2 and result.floors.max == 5 and result.floors.average == 3.5
    assert result.floors.missing_breakdown == {"null": 1, "zero": 1, "invalid": 1}
    assert next(w for w in result.warnings if w.code == "FLOOR_DATA_MISSING").count == 3


def test_partial_result_warning_and_notes():
    result = stats(request([building("bd:1", polygon(rect(0, 0, 10, 10)))], complete=False,
                           javaSummary={"intersecting": 1, "inside": 1, "partial": 0, "outsideExcluded": 2,
                                         "geometryUnavailable": 1, "distinctBuildings": 4,
                                         "mergedDuplicateFeatures": 0},
                           reasons=[{"code": "PAGE_LIMIT", "message": "a"},
                                    {"code": "GEOMETRY_UNAVAILABLE", "message": "b"}]))
    completeness = result.completeness
    targets = {t for note in completeness.notes for t in note.targets}

    assert result.warnings[0].code == "PARTIAL_RESULT"
    assert "JAVA_GEOMETRY_UNAVAILABLE" in codes(result)
    assert completeness.complete is False and completeness.scope == "OBSERVED_BUILDINGS_ONLY"
    assert [r.code for r in completeness.reasons] == ["PAGE_LIMIT", "GEOMETRY_UNAVAILABLE"]
    assert completeness.java_outside_excluded == 2 and completeness.java_geometry_unavailable == 1
    assert {"counts", "footprint.averageArea", "floors.average", "withinRadius.coverageRatio"} <= targets
    # Averages and the coverage ratio are not described as lower bounds.
    for note in completeness.notes:
        assert "하한" not in note.message
    count_note = next(n for n in completeness.notes if "counts" in n.targets)
    assert "작을 수 있습니다" in count_note.message


def test_complete_result_has_no_partial_warning():
    result = stats(request([building("bd:1", polygon(rect(0, 0, 10, 10)))]))

    assert "PARTIAL_RESULT" not in codes(result)
    assert [n.targets for n in result.completeness.notes] == [["footprint", "withinRadius"]]


def test_duplicate_geometry_with_different_ids_is_reported():
    result = stats(request([building("bd:1", polygon(rect(0, 0, 10, 10))),
                            building("feature:x", polygon(rect(0, 0, 10, 10)))]))

    assert result.counts.duplicate_geometry == 1
    assert result.footprint.sum_area == pytest.approx(200, abs=0.01)
    assert result.footprint.union_area == pytest.approx(100, abs=0.01)


def test_java_relation_and_distance_are_compared():
    result = stats(request([
        building("bd:1", polygon(rect(10, -5, 30, 5)), relation="INSIDE", distanceMeters=10.0),
        building("bd:2", polygon(rect(10, -5, 30, 5 + 1e-9)), relation="PARTIAL", distanceMeters=12.0)]))

    assert result.counts.relation_mismatch == 1 and result.counts.distance_mismatch == 1
    assert {"RELATION_MISMATCH", "DISTANCE_MISMATCH"} <= codes(result)


def test_buildings_can_be_omitted_and_are_sorted_by_id():
    payload = request([building("bd:2", polygon(rect(0, 0, 10, 10))), building("bd:1", polygon(rect(20, 0, 30, 10)))])

    assert [b.id for b in stats(payload).buildings] == ["bd:1", "bd:2"]
    assert stats({**payload, "includeBuildings": False}).buildings is None


def test_result_is_deterministic():
    payload = request([building(f"bd:{i}", polygon(rect(i * 3, 0, i * 3 + 5, 5))) for i in range(30)])

    assert stats(payload).model_dump() == stats(payload).model_dump()


def test_5000_buildings(record_property):
    """5000 buildings (the Java maximum) on a grid inside and across a 1 km circle, some overlapping."""
    buildings = []
    for i in range(5000):
        x = -1050 + (i % 75) * 28.0
        y = -1050 + (i // 75) * 28.0 + (i % 3)
        buildings.append(building(f"bd:{i:05d}", polygon(rect(x, y, x + 20 + (i % 7), y + 15)), floors=str(i % 30)))
    payload = request(buildings, radius=1000)

    started = time.perf_counter()
    model = BuildingStatsRequest.model_validate(payload)
    validated = time.perf_counter()
    result = compute_building_stats(model)
    finished = time.perf_counter()
    record_property("validate_seconds", round(validated - started, 3))
    record_property("compute_seconds", round(finished - validated, 3))
    print(f"\n5000 buildings: validate {validated - started:.3f}s, compute {finished - validated:.3f}s")

    assert result.counts.total == 5000
    assert result.counts.analyzed + result.counts.excluded == 5000
    assert result.counts.partial > 0 and result.counts.inside > 0
    assert 0 < result.within_radius.coverage_ratio < 1
    assert finished - started < 10
