import math
import random
import time

import numpy as np
import pytest

from app.geo.grid import grid_cells
from app.schemas.building_stats import BuildingStatsRequest
from app.schemas.grid_density import GridDensityRequest
from app.services.building_stats import compute_building_stats
from app.services.floors import java_round
from app.services.grid_density import compute_grid_density
from tests.factories import PROJECTION, building, multipolygon, polygon, rect, request, ring

GRID_FIELDS = ("cellSizeMeters", "includeEmptyCells", "includeCellBuildingIds")


def grid_request(buildings, size=50, radius=100, **extra) -> dict:
    return request(buildings, radius=radius, cellSizeMeters=size, **extra)


def grid(payload: dict):
    return compute_grid_density(GridDensityRequest.model_validate(payload))


def stats(payload: dict):
    """building-stats on the same analysis (grid options removed)."""
    return compute_building_stats(BuildingStatsRequest.model_validate(
        {k: v for k, v in payload.items() if k not in GRID_FIELDS}))


def cell(result, col, row):
    return next(f.properties for f in result.cells.features if f.id == f"{col}:{row}")


def occupied_cells(result) -> dict[str, tuple[int, int, float]]:
    return {f.id: (f.properties.building_count, f.properties.primary_building_count, f.properties.occupied_area)
            for f in result.cells.features if f.properties.building_count or f.properties.primary_building_count}


def codes(result) -> set[str]:
    return {w.code for w in result.warnings}


def assert_consistent(result):
    c = result.consistency
    assert c.occupied_area_matches and abs(c.occupied_area_calculation_difference) < 1e-6
    assert abs(c.domain_area_calculation_difference) < 1e-6
    assert c.primary_matches_analyzed and c.primary_building_total == result.counts.analyzed
    assert sum(f.properties.primary_building_count for f in result.cells.features) == result.counts.analyzed


# ----------------------------------------------------------------------------------------- basic cases

def test_empty_radius():
    result = grid(grid_request([]))

    assert result.grid.cell_count == 21 and result.grid.returned_cell_count == 21
    assert result.grid.empty_cell_count == 21
    assert all(f.properties.building_count == 0 and f.properties.occupied_area == 0 for f in result.cells.features)
    assert result.summary.occupied_area == 0 and result.summary.coverage_ratio == 0
    assert result.summary.domain_area == pytest.approx(math.pi * 100 ** 2, abs=0.01)
    assert result.counts.total == 0 and result.excluded == []
    assert codes(result) == {"SMALL_BOUNDARY_CELLS"}
    assert_consistent(result)


def test_empty_cells_can_be_left_out():
    payload = grid_request([building("bd:1", polygon(rect(-10, -10, 10, 10)))], includeEmptyCells=False)
    result = grid(payload)

    assert [f.id for f in result.cells.features] == ["0:0"]
    assert result.grid.cell_count == 21 and result.grid.returned_cell_count == 1 and result.grid.empty_cell_count == 20
    # Totals still cover every cell.
    assert result.summary.domain_area == pytest.approx(math.pi * 100 ** 2, abs=0.01)


def test_building_in_one_cell():
    result = grid(grid_request([building("bd:1", polygon(rect(-10, -10, 10, 10)))]))
    c = cell(result, 0, 0)

    assert occupied_cells(result) == {"0:0": (1, 1, pytest.approx(400, abs=0.01))}
    assert c.domain_area == 2500 and c.boundary is False and c.small_boundary is False
    assert c.coverage_ratio == pytest.approx(0.16, abs=1e-6) and c.coverage_percent == 16.0
    assert c.building_ids is None
    assert_consistent(result)


def test_building_across_cells_counts_in_each_but_primary_once():
    result = grid(grid_request([building("bd:1", polygon(rect(-40, -10, 40, 10)))], includeCellBuildingIds=True))

    assert occupied_cells(result) == {"-1:0": (1, 0, pytest.approx(300, abs=0.01)),
                                      "0:0": (1, 1, pytest.approx(1000, abs=0.01)),
                                      "1:0": (1, 0, pytest.approx(300, abs=0.01))}
    assert cell(result, -1, 0).building_ids == ["bd:1"]
    assert result.summary.occupied_cell_count == 3 and result.summary.primary_building_count == 1
    assert_consistent(result)


def test_building_touching_cell_lines_is_only_in_its_cell():
    # Cell (1, 0) covers x 25..75, y -25..25: the building fills it exactly and only touches the neighbours.
    result = grid(grid_request([building("bd:1", polygon(rect(25, -25, 75, 25)))], includeCellBuildingIds=True))

    assert occupied_cells(result) == {"1:0": (1, 1, pytest.approx(2500, abs=0.01))}
    assert cell(result, 1, 0).coverage_ratio == pytest.approx(1, abs=1e-6)
    for col, row in [(0, 0), (2, 0), (1, 1), (1, -1), (0, 1), (2, -1)]:
        assert cell(result, col, row).building_ids == []
        assert cell(result, col, row).occupied_area == 0


def test_equal_parts_go_to_the_first_cell_in_grid_order():
    # 100 m² in each of four cells: the primary cell is the south-west one, (0, 0).
    result = grid(grid_request([building("bd:1", polygon(rect(15, 15, 35, 35)))]))

    assert occupied_cells(result) == {k: (1, int(k == "0:0"), pytest.approx(100, abs=0.01))
                                      for k in ("0:0", "1:0", "0:1", "1:1")}


def test_boundary_cell_uses_the_true_circle_area_as_denominator():
    payload = grid_request([building("bd:1", polygon(rect(80, -20, 120, 20)))])
    result = grid(payload)
    building_stats = stats(payload)
    c = cell(result, 2, 0)    # x 75..125, y -25..25
    small = cell(result, 2, 1)  # x 75..125, y 25..75

    assert c.boundary and not c.small_boundary
    assert c.domain_area == pytest.approx(1197.42, abs=0.01)
    assert c.occupied_area == building_stats.buildings[0].area_in_radius
    assert c.coverage_ratio == pytest.approx(c.occupied_area / c.domain_area, abs=1e-5)  # rounded inputs
    assert small.boundary and small.small_boundary and small.domain_ratio < 0.25
    assert result.grid.boundary_cell_count == 16 and result.grid.small_boundary_cell_count == 8
    assert next(w for w in result.warnings if w.code == "SMALL_BOUNDARY_CELLS").count == 8
    assert_consistent(result)


def test_building_touching_the_circle_goes_to_the_nearest_cell():
    result = grid(grid_request([building("bd:1", polygon(rect(100, -5, 110, 5)))]))

    assert result.counts.analyzed == 1 and result.counts.zero_area_in_radius == 1
    assert occupied_cells(result) == {"2:0": (0, 1, 0)}
    assert result.summary.primary_by_nearest_cell == 1
    assert_consistent(result)


def test_overlap_between_buildings_counts_once():
    result = grid(grid_request([building("bd:1", polygon(rect(0, 0, 10, 10))),
                                building("bd:2", polygon(rect(5, 0, 15, 10))),
                                building("bd:3", polygon(rect(20, 0, 30, 10))),
                                building("bd:4", polygon(rect(22, 0, 32, 10)))]))
    c0, c1 = cell(result, 0, 0), cell(result, 1, 0)

    # Cell (0, 0) ends at x = 25: bd:3 has 50 m² and bd:4 30 m² in it, and they overlap on 22..25.
    assert c0.sum_area == pytest.approx(200 + 50 + 30, abs=0.01)
    assert c0.occupied_area == pytest.approx(150 + 50, abs=0.01)
    assert c0.between_building_overlap_area == pytest.approx(50 + 30, abs=0.01)
    assert c0.building_count == 4 and c0.primary_building_count == 3
    assert c1.sum_area == pytest.approx(50 + 70, abs=0.01) and c1.occupied_area == pytest.approx(70, abs=0.01)
    assert c1.building_count == 2 and c1.primary_building_count == 1
    assert result.summary.sum_area == pytest.approx(400, abs=0.01)
    assert result.summary.occupied_area == pytest.approx(150 + 120, abs=0.01)
    assert "BETWEEN_BUILDING_OVERLAP" in codes(result)
    assert_consistent(result)


def test_polygon_with_hole():
    geometry = polygon(rect(-30, -30, 30, 30), ring([(-10, -10), (-10, 10), (10, 10), (10, -10)]))
    result = grid(grid_request([building("bd:1", geometry)]))

    assert cell(result, 0, 0).occupied_area == pytest.approx(2500 - 400, abs=0.01)
    assert cell(result, 1, 1).occupied_area == pytest.approx(25, abs=0.01)
    assert cell(result, 1, 0).occupied_area == pytest.approx(250, abs=0.01)
    assert result.summary.occupied_area == pytest.approx(3600 - 400, abs=0.01)
    assert result.summary.primary_building_count == 1 and cell(result, 0, 0).primary_building_count == 1
    assert_consistent(result)


def test_multipolygon_parts_in_several_cells_and_overlapping_parts():
    split = multipolygon([rect(-40, -5, -30, 5)], [rect(30, -5, 50, 5)])
    overlapping = multipolygon([rect(0, 0, 10, 10)], [rect(5, 0, 15, 10)])
    result = grid(grid_request([building("bd:1", split), building("bd:2", overlapping)]))

    assert cell(result, -1, 0).building_count == 1 and cell(result, -1, 0).primary_building_count == 0
    assert cell(result, 1, 0).building_count == 1 and cell(result, 1, 0).primary_building_count == 1
    # Overlapping parts of one building count once, also in sumArea, and are not a between-building overlap.
    assert cell(result, 0, 0).sum_area == pytest.approx(150, abs=0.01)
    assert cell(result, 0, 0).between_building_overlap_area == 0
    assert {"MULTI_PART_OVERLAP"} <= codes(result) and "BETWEEN_BUILDING_OVERLAP" not in codes(result)
    assert_consistent(result)


def test_invalid_geometry_is_repaired_or_excluded():
    bowtie = polygon(ring([(0, 0), (10, 10), (10, 0), (0, 10)]))
    collapsed = polygon(ring([(0, 0), (10, 0), (20, 0)]))
    result = grid(grid_request([building("bd:1", bowtie), building("bd:2", collapsed),
                                building("bd:3", polygon(rect(30, 30, 40, 40)))]))

    assert result.counts.analyzed == 2 and result.counts.repaired == 1 and result.counts.excluded == 1
    assert result.excluded[0].id == "bd:2" and result.excluded[0].reason == "INVALID_GEOMETRY"
    assert cell(result, 0, 0).occupied_area == pytest.approx(50, abs=0.01)
    assert {"GEOMETRY_REPAIRED", "GEOMETRY_EXCLUDED"} <= codes(result)
    assert any("counts.analyzed" in n.targets for n in result.completeness.notes)
    assert_consistent(result)


def test_partial_result_is_not_presented_as_complete_density():
    result = grid(grid_request([building("bd:1", polygon(rect(0, 0, 10, 10)))], complete=False))
    targets = {t for note in result.completeness.notes for t in note.targets}

    assert result.completeness.complete is False and result.completeness.scope == "OBSERVED_BUILDINGS_ONLY"
    assert result.warnings[0].code == "PARTIAL_RESULT"
    assert {"cells.features[].properties.coverageRatio", "cells.features[].properties.buildingCount",
            "summary.coverageRatio"} <= targets
    assert any("밀집도" in n.message for n in result.completeness.notes)


def test_complete_result_has_no_partial_warning():
    result = grid(grid_request([building("bd:1", polygon(rect(0, 0, 10, 10)))]))

    assert "PARTIAL_RESULT" not in codes(result)
    assert result.completeness.scope == "COMPLETE_RESULT"


# ----------------------------------------------------------------------------------------- cell sizes and GeoJSON

@pytest.mark.parametrize("size", [50, 100, 200])
def test_cell_sizes(size):
    buildings = [building(f"bd:{i}", polygon(rect(-200 + i * 25, -150 + (i % 5) * 60,
                                                    -185 + i * 25, -130 + (i % 5) * 60))) for i in range(15)]
    result = grid(grid_request(buildings, size=size, radius=300))
    features = result.cells.features

    assert result.cell_size_meters == size and result.grid.cell_area == size * size
    assert result.grid.cell_count == len(grid_cells(300, size)) == len(features)
    assert all(f.properties.cell_area == size * size for f in features)
    assert result.summary.occupied_area == pytest.approx(15 * 15 * 20, abs=0.01)
    assert_consistent(result)


@pytest.mark.parametrize("size", [50, 100, 200])
def test_geojson_cells_match_the_grid(size):
    result = grid(grid_request([], size=size, radius=300))

    for feature in result.cells.features:
        p = feature.properties
        coords = feature.geometry.coordinates
        assert feature.type == "Feature" and feature.geometry.type == "Polygon" and len(coords) == 1
        outer = coords[0]
        assert len(outer) == 5 and outer[0] == outer[-1]
        xy = [(PROJECTION.x(lon), PROJECTION.y(lat)) for lon, lat in outer]
        expected = [((p.col - .5) * size, (p.row - .5) * size), ((p.col + .5) * size, (p.row - .5) * size),
                    ((p.col + .5) * size, (p.row + .5) * size), ((p.col - .5) * size, (p.row + .5) * size)]
        assert np.allclose(xy[:4], expected, atol=1e-3)  # 1 mm (coordinates are rounded to 1e-9 degrees)
        # Counterclockwise exterior ring (RFC 7946).
        assert sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(xy, xy[1:])) > 0
        assert (PROJECTION.x(p.center_lon), PROJECTION.y(p.center_lat)) == pytest.approx(
            (p.col * size, p.row * size), abs=1e-3)
    center = cell(result, 0, 0)
    assert (center.center_lon, center.center_lat) == (127.0, 37.5)


def test_adjacent_cells_share_corner_coordinates():
    result = grid(grid_request([], size=100, radius=300))
    a = next(f for f in result.cells.features if f.id == "0:0").geometry.coordinates[0]
    b = next(f for f in result.cells.features if f.id == "1:0").geometry.coordinates[0]

    assert a[1] == b[0] and a[2] == b[3]


# ----------------------------------------------------------------------------------------- consistency with 8-2

def random_buildings(seed: int, count: int, radius: int) -> list[dict]:
    rng = random.Random(seed)
    buildings = []
    for i in range(count):
        x, y = rng.uniform(-radius * 1.05, radius * 1.05), rng.uniform(-radius * 1.05, radius * 1.05)
        w, h = rng.uniform(3, 40), rng.uniform(3, 40)
        if i % 10 == 0:
            geometry = multipolygon([rect(x, y, x + w, y + h)], [rect(x + w / 2, y, x + w * 1.5, y + h)])
        elif i % 17 == 0:
            geometry = polygon(rect(x, y, x + w + 10, y + h + 10), rect(x + 3, y + 3, x + 6, y + 6))
        else:
            geometry = polygon(rect(x, y, x + w, y + h))
        buildings.append(building(f"bd:{i}", geometry))
    return buildings


@pytest.mark.parametrize(("seed", "radius", "size"), [(1, 300, 50), (2, 300, 100), (3, 500, 200), (4, 1000, 50),
                                                      (5, 50, 50), (6, 50, 200)])
def test_matches_building_stats(seed, radius, size):
    payload = grid_request(random_buildings(seed, 400, radius), size=size, radius=radius)
    result = grid(payload)
    building_stats = stats(payload)

    assert result.counts == building_stats.counts
    assert result.excluded == building_stats.excluded
    assert result.method == building_stats.method
    assert result.consistency.within_radius_union_area == building_stats.within_radius.union_area
    assert result.summary.occupied_area == pytest.approx(building_stats.within_radius.union_area, abs=0.01)
    assert result.summary.sum_area == building_stats.within_radius.sum_area
    assert result.summary.coverage_ratio == pytest.approx(building_stats.within_radius.coverage_ratio, abs=1e-6)
    assert result.summary.domain_area == building_stats.method.circle_area
    assert_consistent(result)
    # The display difference is exactly what the rounded cell values add up to.
    shown = math.fsum(f.properties.occupied_area for f in result.cells.features)
    assert result.consistency.occupied_area_display_difference == java_round(
        shown - result.consistency.within_radius_union_area, 100)
    assert abs(result.consistency.occupied_area_display_difference) <= 0.005 * result.grid.cell_count + 0.01
    # Every cell coverage stays within [0, 1].
    assert all(0 <= f.properties.coverage_ratio <= 1 for f in result.cells.features)


def test_cell_building_counts_cover_every_building_with_area():
    payload = grid_request(random_buildings(7, 300, 300), size=50, radius=300, includeCellBuildingIds=True)
    result = grid(payload)
    building_stats = stats(payload)
    listed = {i for f in result.cells.features for i in f.properties.building_ids}

    assert listed == {b.id for b in building_stats.buildings if b.area_in_radius >= 0.01}
    assert sum(f.properties.building_count for f in result.cells.features) >= len(listed)
    for f in result.cells.features:
        assert f.properties.building_ids == sorted(f.properties.building_ids)
        assert f.properties.building_count == len(f.properties.building_ids)


def test_result_is_deterministic():
    payload = grid_request(random_buildings(8, 200, 300), size=100, radius=300)

    assert grid(payload).model_dump() == grid(payload).model_dump()


# ----------------------------------------------------------------------------------------- performance

def test_5000_buildings_1km(record_property):
    """5000 buildings on a 1 km radius (the Java maximum), some overlapping, 50 m cells (1345 cells)."""
    buildings = []
    for i in range(5000):
        x = -1050 + (i % 75) * 28.0
        y = -1050 + (i // 75) * 28.0 + (i % 3)
        buildings.append(building(f"bd:{i:05d}", polygon(rect(x, y, x + 20 + (i % 7), y + 15)), floors=str(i % 30)))
    payload = grid_request(buildings, size=50, radius=1000)

    started = time.perf_counter()
    model = GridDensityRequest.model_validate(payload)
    validated = time.perf_counter()
    result = compute_grid_density(model)
    finished = time.perf_counter()
    record_property("validate_seconds", round(validated - started, 3))
    record_property("compute_seconds", round(finished - validated, 3))
    print(f"\n5000 buildings grid (50 m): validate {validated - started:.3f}s, compute {finished - validated:.3f}s, "
          f"{result.grid.cell_count} cells")

    assert result.counts.total == 5000 and result.grid.cell_count == 1345
    assert_consistent(result)
    assert finished - started < 10
