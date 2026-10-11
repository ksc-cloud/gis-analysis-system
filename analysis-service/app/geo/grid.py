"""Square grid on the local tangent plane of the analysis center, clipped to the radius circle.

Cell (col, row) covers x in [(col - 0.5)·s, (col + 0.5)·s] and y in [(row - 0.5)·s, (row + 0.5)·s] (x east,
y north, meters), so cell (0, 0) is centered on the analysis center and the grid is symmetric around it. A cell
belongs to the grid when it shares area with the true circle; its domain area is that shared area, computed
exactly (not with the 256-gon).
"""

import math
from dataclasses import dataclass

#: Cell sizes accepted by the grid-density API (m).
CELL_SIZES = (50, 100, 200)

#: Domains smaller than this (m²) are numerical zeros: the cell only touches the circle.
MIN_DOMAIN_AREA_M2 = 1e-6


@dataclass(frozen=True)
class Cell:
    """
    col, row: integer position, (0, 0) is centered on the analysis center
    x0, y0, x1, y1: bounds in meters
    domain_area: area of the cell inside the true circle (m²)
    """

    col: int
    row: int
    x0: float
    y0: float
    x1: float
    y1: float
    domain_area: float

    @property
    def cell_area(self) -> float:
        return (self.x1 - self.x0) * (self.y1 - self.y0)

    @property
    def domain_ratio(self) -> float:
        return self.domain_area / self.cell_area


def grid_cells(radius: float, size: float) -> list[Cell]:
    """Cells that share area with the circle, ordered by row then column (south-west first)."""
    reach = math.ceil(radius / size + 0.5)
    cells = []
    for row in range(-reach, reach + 1):
        for col in range(-reach, reach + 1):
            x0, x1 = (col - 0.5) * size, (col + 0.5) * size
            y0, y1 = (row - 0.5) * size, (row + 0.5) * size
            if _nearest_distance(x0, y0, x1, y1) >= radius:
                continue
            domain = disk_rect_area(x0, y0, x1, y1, radius)
            if domain > MIN_DOMAIN_AREA_M2:
                cells.append(Cell(col, row, x0, y0, x1, y1, domain))
    return cells


def disk_rect_area(x0: float, y0: float, x1: float, y1: float, radius: float) -> float:
    """Exact area of the rectangle [x0, x1] x [y0, y1] inside the disk of ``radius`` around the origin."""
    area = (_corner(x1, y1, radius) - _corner(x0, y1, radius)
            - _corner(x1, y0, radius) + _corner(x0, y0, radius))
    return max(0.0, area)


def _corner(x: float, y: float, r: float) -> float:
    """Signed area of the disk inside [0, x] x [0, y] (negative when exactly one of x, y is negative)."""
    sign = (1 if x >= 0 else -1) * (1 if y >= 0 else -1)
    x = min(abs(x), r)
    y = min(abs(y), r)
    # Up to x_flat the rectangle top y is below the circle; beyond it the circle is the top.
    x_flat = min(x, math.sqrt(max(r * r - y * y, 0.0)))
    return sign * (y * x_flat + _arc(x_flat, x, r))


def _arc(a: float, b: float, r: float) -> float:
    """Integral of sqrt(r² - t²) from a to b (0 <= a <= b <= r)."""

    def f(t):
        return (t * math.sqrt(max(r * r - t * t, 0.0)) + r * r * math.asin(min(1.0, t / r))) / 2

    return f(b) - f(a)


def _nearest_distance(x0: float, y0: float, x1: float, y1: float) -> float:
    dx = max(x0, 0.0, -x1)
    dy = max(y0, 0.0, -y1)
    return math.hypot(dx, dy)
