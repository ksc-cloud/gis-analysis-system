import math

import pytest
import shapely

from app.geo.grid import CELL_SIZES, disk_rect_area, grid_cells
from tests.factories import rect_in_disk_area


@pytest.mark.parametrize("radius", [50, 75, 100, 137, 300, 999, 1000])
@pytest.mark.parametrize("size", CELL_SIZES)
def test_domains_partition_the_circle(radius, size):
    cells = grid_cells(radius, size)

    assert math.fsum(c.domain_area for c in cells) == pytest.approx(math.pi * radius * radius, abs=1e-6)
    assert all(0 < c.domain_area <= c.cell_area + 1e-9 for c in cells)
    assert len({(c.col, c.row) for c in cells}) == len(cells)


@pytest.mark.parametrize("size", CELL_SIZES)
def test_cell_zero_is_centered_on_the_analysis_center(size):
    cell = next(c for c in grid_cells(300, size) if (c.col, c.row) == (0, 0))

    assert (cell.x0, cell.y0, cell.x1, cell.y1) == (-size / 2, -size / 2, size / 2, size / 2)
    assert cell.cell_area == size * size


def test_grid_is_symmetric_and_ordered_south_west_first():
    cells = grid_cells(1000, 100)
    keys = [(c.row, c.col) for c in cells]

    assert keys == sorted(keys)
    assert {(c.col, c.row) for c in cells} == {(-c.col, -c.row) for c in cells}
    assert {(c.col, c.row) for c in cells} == {(c.row, c.col) for c in cells}


def test_cells_only_touching_the_circle_are_left_out():
    # r = 75, s = 50: the cell (2, 0) starts at x = 75 and shares only the point (75, 0) with the circle.
    keys = {(c.col, c.row) for c in grid_cells(75, 50)}

    assert (2, 0) not in keys and (1, 0) in keys
    assert len(keys) == 9


@pytest.mark.parametrize(("x0", "x1", "h"), [(90, 110, 10), (95, 140, 30), (0, 80, 20), (-30, 30, 30), (60, 90, 70)])
def test_disk_rect_area_matches_the_closed_form(x0, x1, h):
    if x0 >= 0:
        assert disk_rect_area(x0, -h, x1, h, 100) == pytest.approx(rect_in_disk_area(100, x0, x1, h), abs=1e-9)
    # Against a dense polygon: 65536-gon, area error about 1.5e-7 of the circle.
    disk = shapely.Point(0, 0).buffer(100, quad_segs=16384)
    expected = disk.intersection(shapely.box(x0, -h, x1, h)).area
    assert disk_rect_area(x0, -h, x1, h, 100) == pytest.approx(expected, abs=0.01)


@pytest.mark.parametrize(("x0", "y0", "x1", "y1"), [(-125, -25, -75, 25), (25, 75, 75, 125), (-75, -75, -25, -25)])
def test_disk_rect_area_in_every_quadrant(x0, y0, x1, y1):
    disk = shapely.Point(0, 0).buffer(100, quad_segs=16384)

    assert disk_rect_area(x0, y0, x1, y1, 100) == pytest.approx(
        disk.intersection(shapely.box(x0, y0, x1, y1)).area, abs=0.01)
