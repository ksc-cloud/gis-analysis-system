"""Hotspot service (app.services.hotspot): blocking policy, grid-density reuse, joining the statistics to the cells,
rounding and statuses. Statistics themselves are tested in test_hotspot_stats.py."""

import math
import time

import numpy as np
import pytest
from pydantic import ValidationError

from app.schemas.grid_density import GridDensityRequest
from app.schemas.hotspot import HotspotClass, HotspotRequest
from app.services import hotspot as service
from app.services import hotspot_stats as hs
from app.services.floors import java_round
from app.services.grid_density import compute_grid_density
from tests.factories import building, polygon, rect, request, ring

ALL_REASONS = ["PAGE_LIMIT", "TIME_LIMIT", "EXTERNAL_API_ERROR", "EXTERNAL_API_TIMEOUT", "PAGINATION_INCONSISTENT",
               "TOTAL_CHANGED", "COUNT_MISMATCH", "GEOMETRY_UNAVAILABLE", "TOTAL_UNKNOWN"]


def background(radius=300, size=50) -> list[dict]:
    """A 4 m x 4 m building in the middle of every 50 m cell well inside the circle: coverage 0.0064, never 0."""
    result = []
    reach = radius // size
    for col in range(-reach, reach + 1):
        for row in range(-reach, reach + 1):
            if math.hypot(col * size, row * size) < radius - 40:
                x, y = col * size - 2, row * size - 2
                result.append(building(f"bg:{col}:{row}", polygon(rect(x, y, x + 4, y + 4))))
    return result


def dense_block() -> list[dict]:
    """25 buildings of 8 m x 8 m around (100..148, 100..148): cells (2, 2) to (3, 3) are dense."""
    return [building(f"bd:{i}", polygon(rect(100 + (i % 5) * 10, 100 + (i // 5) * 10,
                                             108 + (i % 5) * 10, 108 + (i // 5) * 10))) for i in range(25)]


def payload(buildings, radius=300, size=50, **extra) -> dict:
    return request(buildings, radius=radius, cellSizeMeters=size, **extra)


def hotspot(data: dict):
    return service.compute_hotspot(HotspotRequest.model_validate(data))


def grid_of(data: dict):
    """grid-density of the same analysis with its default options (every cell)."""
    grid_data = {k: v for k, v in data.items() if k not in ("permutations", "seed")}
    return compute_grid_density(GridDensityRequest.model_validate(grid_data))


def by_id(result) -> dict:
    return {f.id: f.properties for f in result.cells.features}


def reasons(*codes) -> list[dict]:
    return [{"code": code, "message": f"{code} 메시지"} for code in codes]


@pytest.fixture
def no_computation(monkeypatch):
    """Fails the test if the grid or the statistics are computed."""
    def fail(*args, **kwargs):
        raise AssertionError("must not be called")
    monkeypatch.setattr(service, "compute_grid_density", fail)
    monkeypatch.setattr(service.hotspot_stats, "analyze", fail)


# ----------------------------------------------------------------------------------------------- analysis

def test_dense_block_is_a_hotspot():
    result = hotspot(payload(background() + dense_block()))
    cells = by_id(result)

    assert result.status == "OK" and result.blocked_reasons == []
    assert cells["2:2"].hotspot_class == "HOT_99" and cells["2:2"].bin == 3 and cells["2:2"].gi_z > 3
    assert cells["-3:-3"].hotspot_class == "NOT_SIGNIFICANT"
    assert result.moran.i > result.moran.expected and result.moran.p_value == pytest.approx(1 / 1000)
    assert [w.code for w in result.warnings if w.code in ("SPARSE_VALUES", "CONSTANT_VALUES",
                                                          "INSUFFICIENT_CELLS")] == []
    assert result.method.permutations == 999 and result.method.seed == 20261012
    assert result.completeness.complete and result.completeness.source_complete
    assert result.completeness.python_geometry_excluded == 0


def test_cells_keep_the_grid_density_ids_geometry_order_and_values():
    data = payload(background() + dense_block())
    result = hotspot(data)
    grid = grid_of(data)

    assert [f.id for f in result.cells.features] == [f.id for f in grid.cells.features]
    assert [f.geometry for f in result.cells.features] == [f.geometry for f in grid.cells.features]
    for mine, theirs in zip(result.cells.features, grid.cells.features):
        p, g = mine.properties, theirs.properties
        assert (p.col, p.row, p.center_lon, p.center_lat, p.boundary, p.small_boundary, p.domain_ratio,
                p.coverage_ratio) == (g.col, g.row, g.center_lon, g.center_lat, g.boundary, g.small_boundary,
                                      g.domain_ratio, g.coverage_ratio)
    assert result.grid == grid.grid and result.counts == grid.counts
    assert result.summary.cell_count == grid.grid.cell_count == len(result.cells.features)


JAVA_SUMMARY = {"intersecting": 25, "inside": 25, "partial": 0, "outsideExcluded": 4, "geometryUnavailable": 0,
                "distinctBuildings": 29, "mergedDuplicateFeatures": 1}


def test_grid_request_carries_every_analysis_field():
    data = payload([building("bd:1", polygon(rect(10, 10, 20, 20)), relation="INSIDE", distanceMeters=14.14)],
                   source={"kind": "SAVED", "analysisId": 7, "analyzedAt": "2026-10-01T09:00:00Z"},
                   javaSummary=JAVA_SUMMARY, permutations=99, seed=3)
    grid_request = service.grid_request(HotspotRequest.model_validate(data))

    expected = {k: v for k, v in data.items() if k not in ("permutations", "seed")}
    assert grid_request == GridDensityRequest.model_validate({**expected, "includeEmptyCells": True,
                                                              "includeCellBuildingIds": False})


def test_ok_completeness_keeps_the_java_summary():
    result = hotspot(payload(background() + dense_block(), javaSummary=JAVA_SUMMARY))

    assert result.status == "OK"
    assert result.completeness.java_outside_excluded == 4 and result.completeness.java_geometry_unavailable == 0


def test_statistics_are_the_analyze_results_of_the_grid_cells():
    data = payload(background() + dense_block(), permutations=99, seed=5)
    result = hotspot(data)
    cells = [f.properties for f in grid_of(data).cells.features]
    expected = hs.analyze([c.col for c in cells], [c.row for c in cells], [c.coverage_ratio for c in cells],
                          [c.small_boundary for c in cells], permutations=99, seed=5)

    for feature, cell in zip(result.cells.features, expected.cells):
        p = feature.properties
        assert (p.hotspot_class, p.bin, p.reason, p.neighbor_count) == (cell.hotspot_class, cell.bin, cell.reason,
                                                                         cell.neighbor_count)
        if cell.z is None:
            assert p.gi_z is None and p.p_value is None and p.q_value is None
        else:
            assert p.gi_z == java_round(cell.z, 1e4)
            assert p.p_value == float(f"{cell.p_value:.6g}") and p.q_value == float(f"{cell.q_value:.6g}")
    assert result.summary.classes == expected.summary
    assert result.summary.tested_cell_count == expected.tested_cell_count
    assert result.moran.i == java_round(expected.moran.i, 1e6)
    assert result.moran.p_value == expected.moran.p_value
    assert result.method.permutations == 99 and result.method.seed == 5


def test_small_boundary_cells_are_not_tested():
    result = hotspot(payload(background() + dense_block()))
    small = [f.properties for f in result.cells.features if f.properties.small_boundary]

    assert len(small) == result.grid.small_boundary_cell_count > 0
    assert all(p.hotspot_class == "NOT_TESTED" and p.reason == "SMALL_BOUNDARY" and p.neighbor_count is None
               and p.gi_z is None and p.p_value is None and p.q_value is None and p.bin is None for p in small)
    assert result.summary.not_tested_reasons["SMALL_BOUNDARY"] == len(small)
    assert result.summary.tested_cell_count == result.summary.cell_count - len(small)


def test_constant_values_return_every_cell_untested():
    result = hotspot(payload([]))  # no buildings: coverage 0 everywhere

    assert result.status == "CONSTANT_VALUES" and result.moran is None and result.grid is not None
    assert len(result.cells.features) == result.grid.cell_count == 137
    assert {f.properties.reason for f in result.cells.features} == {"CONSTANT_VALUES", "SMALL_BOUNDARY"}
    assert all(f.properties.hotspot_class == "NOT_TESTED" and f.properties.gi_z is None
               for f in result.cells.features)
    assert result.summary.classes["NOT_TESTED"] == 137 and result.summary.tested_cell_count == 0
    warning = next(w for w in result.warnings if w.code == "CONSTANT_VALUES")
    assert "모두 같아" in warning.message and warning.count == 121
    assert result.completeness.complete  # complete data, just nothing to test


def test_too_few_cells():
    result = hotspot(payload(dense_block(), radius=100))  # 21 cells, 13 not small boundary

    assert result.status == "INSUFFICIENT_CELLS" and result.moran is None
    assert result.summary.study_cell_count == 13 and result.summary.tested_cell_count == 0
    assert result.summary.not_tested_reasons == {"SMALL_BOUNDARY": 8, "NO_NEIGHBORS": 0, "UNDEFINED_VARIANCE": 0,
                                                 "CONSTANT_VALUES": 0, "INSUFFICIENT_CELLS": 13}
    warning = next(w for w in result.warnings if w.code == "INSUFFICIENT_CELLS")
    assert warning.count == 13 and "13개" in warning.message and "30개" in warning.message


def test_sparse_values_warn_but_stay_ok():
    result = hotspot(payload(dense_block()))  # buildings in 4 of 121 tested cells

    assert result.status == "OK"
    warning = next(w for w in result.warnings if w.code == "SPARSE_VALUES")
    assert "정규 근사" in warning.message and warning.count == 121


def test_method_documents_the_limits_of_the_normal_approximation_and_fdr():
    method = hotspot(payload(dense_block())).method

    assert any("정규 근사" in text for text in method.limitations)
    assert any("FDR" in text and "명목값" in text for text in method.limitations)
    assert "반올림 전 q값" in method.description


def test_hotspot_class_literal_matches_the_statistics_module():
    assert tuple(HotspotClass.__args__) == hs.CLASSES


# ------------------------------------------------------------------------------------------- blocking policy

@pytest.mark.parametrize("code", ALL_REASONS + ["FUTURE_REASON"])
def test_every_incomplete_reason_blocks_without_computing(no_computation, code):
    data = payload(background() + dense_block(), complete=False, reasons=reasons(code))
    result = hotspot(data)

    assert result.status == "PARTIAL_RESULT_BLOCKED" and result.blocked_reasons == [code]
    assert result.grid is None and result.counts is None and result.moran is None
    assert result.cells.features == []
    assert result.summary.cell_count == result.summary.study_cell_count == result.summary.tested_cell_count == 0
    assert set(result.summary.classes.values()) == {0} and set(result.summary.not_tested_reasons.values()) == {0}
    assert result.completeness.complete is False and result.completeness.source_complete is False
    assert result.completeness.scope == "OBSERVED_BUILDINGS_ONLY"
    assert [(r.code, r.message) for r in result.completeness.reasons] == [(code, f"{code} 메시지")]
    assert result.completeness.python_geometry_excluded is None
    assert [w.code for w in result.warnings] == ["PARTIAL_RESULT_BLOCKED"]
    assert code in result.warnings[0].message
    assert ("알 수 없는 사유 코드" in result.warnings[0].message) == (code == "FUTURE_REASON")


def test_several_reasons_are_all_reported_once_in_request_order(no_computation):
    data = payload(dense_block(), complete=False,
                   reasons=reasons("TOTAL_UNKNOWN", "GEOMETRY_UNAVAILABLE", "TOTAL_UNKNOWN", "SOMETHING_NEW"))
    result = hotspot(data)

    assert result.blocked_reasons == ["TOTAL_UNKNOWN", "GEOMETRY_UNAVAILABLE", "SOMETHING_NEW"]
    assert "SOMETHING_NEW" in result.warnings[0].message and "알 수 없는 사유 코드(SOMETHING_NEW)" in \
        result.warnings[0].message


def test_blocked_completeness_keeps_the_java_summary(no_computation):
    summary = {"intersecting": 3, "inside": 2, "partial": 1, "outsideExcluded": 4, "geometryUnavailable": 2,
               "distinctBuildings": 9, "mergedDuplicateFeatures": 0}
    result = hotspot(payload(dense_block(), complete=False, reasons=reasons("GEOMETRY_UNAVAILABLE"),
                             javaSummary=summary))

    assert result.completeness.java_geometry_unavailable == 2 and result.completeness.java_outside_excluded == 4


@pytest.mark.parametrize(("complete", "codes"), [(False, []), (True, ["PAGE_LIMIT"])])
def test_complete_and_reasons_must_agree(complete, codes):
    with pytest.raises(ValidationError, match="completeness_mismatch"):
        HotspotRequest.model_validate(payload(dense_block(), complete=complete, reasons=reasons(*codes)))


def collapsed() -> dict:
    """A ring along a line: make_valid leaves no polygon, Python excludes it as INVALID_GEOMETRY."""
    return building("bd:bad", polygon(ring([(0, 0), (10, 0), (20, 0)])))


def test_a_building_python_cannot_repair_blocks_without_statistics(monkeypatch):
    calls = []
    real = service.compute_grid_density
    monkeypatch.setattr(service, "compute_grid_density", lambda r: calls.append(r) or real(r))

    def fail(*args, **kwargs):
        raise AssertionError("must not be called")
    monkeypatch.setattr(service.hotspot_stats, "analyze", fail)
    data = payload(background() + dense_block() + [collapsed()])
    result = hotspot(data)

    assert len(calls) == 1  # the grid had to be computed to see the exclusion
    assert [e.reason for e in grid_of(data).excluded] == ["INVALID_GEOMETRY"]
    assert result.status == "PARTIAL_RESULT_BLOCKED" and result.blocked_reasons == ["PYTHON_GEOMETRY_EXCLUDED"]
    assert result.grid is None and result.counts is None and result.moran is None and result.cells.features == []
    # Not complete for the hotspot, although Java's analysis was.
    assert result.completeness.complete is False and result.completeness.source_complete is True
    assert result.completeness.scope == "OBSERVED_BUILDINGS_ONLY" and result.completeness.reasons == []
    assert result.completeness.python_geometry_excluded == 1
    assert any("1개" in n.message and "blockedReasons" in n.targets for n in result.completeness.notes)
    assert result.warnings[0].code == "PARTIAL_RESULT_BLOCKED" and result.warnings[0].count == 1


def test_zero_area_and_outside_radius_buildings_do_not_block():
    tiny = building("bd:tiny", polygon(rect(-120, -120, -119.95, -119.95)))  # 0.0025 m² < 0.01 m²
    outside = building("bd:far", polygon(rect(400, 0, 410, 10)))  # 100 m outside the 300 m circle
    base = background() + dense_block()
    with_them = hotspot(payload(base + [tiny, outside]))
    without = hotspot(payload(base))

    assert sorted(e.reason for e in grid_of(payload(base + [tiny, outside])).excluded) == ["OUTSIDE_RADIUS",
                                                                                          "ZERO_AREA"]
    assert with_them.status == "OK" and with_them.blocked_reasons == []
    assert with_them.completeness.complete and with_them.completeness.python_geometry_excluded == 0
    assert with_them.cells == without.cells and with_them.moran == without.moran


def test_blocked_exactly_when_the_completeness_is_not_complete():
    cases = [payload(dense_block()), payload([]), payload(dense_block(), radius=100),
             payload(dense_block(), complete=False, reasons=reasons("PAGE_LIMIT")),
             payload(dense_block() + [collapsed()])]
    for data in cases:
        result = hotspot(data)
        assert (result.status == "PARTIAL_RESULT_BLOCKED") == (result.completeness.complete is False)


# ------------------------------------------------------------------------------------------------ rounding

def cell_result(z, p, q, hotspot_class, level_bin):
    return hs.CellResult(neighbor_count=8, z=z, p_value=p, q_value=q, hotspot_class=hotspot_class, bin=level_bin,
                         reason=None)


@pytest.mark.parametrize(("q", "hotspot_class", "level_bin", "shown"), [
    (0.0100000004, "HOT_95", 2, 0.01),        # shown as 0.01 but above the 99 % limit: stays 95 %
    (0.0499999999, "HOT_95", 2, 0.05),        # shown as 0.05, below the limit: stays 95 %
    (0.1000000003, "NOT_SIGNIFICANT", 0, 0.1),  # shown as 0.1 but not significant
])
def test_rounding_never_changes_the_class(q, hotspot_class, level_bin, shown):
    grid_cell = grid_of(payload(dense_block())).cells.features[60].properties
    properties = service.cell_properties(grid_cell, cell_result(2.5, 0.01, q, hotspot_class, level_bin))

    assert properties.q_value == shown
    assert (properties.hotspot_class, properties.bin) == (hotspot_class, level_bin)


def test_rounding_of_z_p_q():
    assert service.significant(1.234567891e-12) == 1.23457e-12
    assert service.significant(0.000123456789) == 0.000123457
    assert service.significant(0.0) == 0.0 and service.significant(None) is None
    assert service.significant(1.0) == 1.0
    grid_cell = grid_of(payload(dense_block())).cells.features[60].properties
    properties = service.cell_properties(grid_cell, cell_result(-1.23456789, 3.2e-15, 4.87654321e-13, "COLD_99", -3))
    assert properties.gi_z == -1.2346 and properties.p_value == 3.2e-15 and properties.q_value == 4.87654e-13


def test_untested_cells_have_null_statistics():
    grid_cell = grid_of(payload(dense_block())).cells.features[0].properties
    properties = service.cell_properties(grid_cell, hs.CellResult(None, None, None, None, "NOT_TESTED", None,
                                                                  "SMALL_BOUNDARY"))

    assert (properties.gi_z, properties.p_value, properties.q_value, properties.bin) == (None, None, None, None)
    assert properties.reason == "SMALL_BOUNDARY"


# ---------------------------------------------------------------------------------------------- determinism

def test_same_request_same_result():
    data = payload(background() + dense_block())

    assert hotspot(data).model_dump() == hotspot(data).model_dump()


def test_the_seed_changes_only_the_permutation_results():
    first = hotspot(payload(background() + dense_block(), seed=1))
    other = hotspot(payload(background() + dense_block(), seed=2))

    assert first.cells == other.cells and first.summary == other.summary
    assert first.moran.i == other.moran.i
    assert first.moran.simulated_mean != other.moran.simulated_mean


# ------------------------------------------------------------------------------------- boundary cells (observed)

def test_boundary_cells_of_a_fine_uniform_layout_match_the_interior(record_property):
    """5 m squares on a 10 m pitch: coverage 25 % at any scale. Interior cells are exactly 0.25; boundary cells
    (at least 25 % inside the circle) stay close to it, so the grid adds no systematic boundary offset here."""
    buildings = []
    for i in range(-31, 31):
        for j in range(-31, 31):
            x, y = i * 10 + 2.5, j * 10 + 2.5
            if math.hypot(abs(x) - 10, abs(y) - 10) <= 300:
                buildings.append(building(f"bd:{i}:{j}", polygon(rect(x, y, x + 5, y + 5))))
    cells = [f.properties for f in grid_of(payload(buildings)).cells.features]
    interior = np.array([c.coverage_ratio for c in cells if not c.boundary])
    boundary = np.array([c.coverage_ratio for c in cells if c.boundary and not c.small_boundary])
    record_property("interior_mean", float(interior.mean()))
    record_property("boundary_mean", float(boundary.mean()))

    assert np.all(interior == 0.25)
    assert abs(boundary.mean() - 0.25) < 0.005


def test_boundary_cells_of_a_coarse_layout_can_differ_from_the_interior(record_property):
    """One 25 m building centered in every 50 m cell: interior coverage is exactly 0.25, but where the circle cuts a
    cell its value depends on whether it cuts the building or the empty margin. All variation then comes from the
    boundary, and boundary cells and their neighbors can be classified. Recorded as a known interpretation limit
    (method.limitations), not corrected: the grid-density coverage is unchanged in this step."""
    buildings = []
    for i in range(-21, 22):
        for j in range(-21, 22):
            x, y = i * 50 - 12.5, j * 50 - 12.5
            if math.hypot(abs(x) - 25, abs(y) - 25) <= 1000:
                buildings.append(building(f"bd:{i}:{j}", polygon(rect(x, y, x + 25, y + 25))))
    result = hotspot(payload(buildings, radius=1000))
    cells = [f.properties for f in result.cells.features]
    interior = [c.coverage_ratio for c in cells if not c.boundary]
    boundary = np.array([c.coverage_ratio for c in cells if c.boundary and not c.small_boundary])
    significant_cells = [c for c in cells if c.hotspot_class.startswith(("HOT", "COLD"))]
    record_property("boundary_mean", float(boundary.mean()))
    record_property("boundary_sd", float(boundary.std()))
    record_property("significant_cells", len(significant_cells))

    assert set(interior) == {0.25}
    assert boundary.std() > 0.01
    near_boundary = [c for c in significant_cells if c.boundary or math.hypot(c.col, c.row) * 50 > 1000 - 2 * 50 * 1.5]
    assert len(near_boundary) == len(significant_cells)  # every classified cell lies on or next to the boundary


# ----------------------------------------------------------------------------------------------- performance

def test_5000_buildings_1km(record_property):
    """1 km radius, 50 m cells (1345 cells), 5000 synthetic buildings, 999 permutations: the whole service."""
    buildings = []
    for i in range(5000):
        x = -1050 + (i % 75) * 28.0
        y = -1050 + (i // 75) * 28.0 + (i % 3)
        buildings.append(building(f"bd:{i:05d}", polygon(rect(x, y, x + 20 + (i % 7), y + 15)), floors=str(i % 30)))
    data = payload(buildings, radius=1000)

    started = time.perf_counter()
    model = HotspotRequest.model_validate(data)
    validated = time.perf_counter()
    result = service.compute_hotspot(model)
    finished = time.perf_counter()
    record_property("validate_seconds", round(validated - started, 3))
    record_property("compute_seconds", round(finished - validated, 3))
    print(f"\n5000 buildings hotspot (50 m, 999 permutations): validate {validated - started:.3f}s, "
          f"compute {finished - validated:.3f}s, {result.summary.cell_count} cells, "
          f"{result.summary.tested_cell_count} tested")

    assert result.status == "OK" and result.summary.cell_count == 1345 and result.summary.tested_cell_count == 1289
    assert finished - started < 10
