"""Synthetic test data: shapes are designed in meters around the center and converted to lon/lat with the
same projection, so expected areas are known exactly."""

import math

from app.geo.projection import LocalProjection

CENTER = {"lon": 127.0, "lat": 37.5}
PROJECTION = LocalProjection(CENTER["lon"], CENTER["lat"])
TOKEN = "test-internal-token"
AUTH = {"X-Internal-Token": TOKEN}


def ring(points_m) -> list[list[float]]:
    coords = [[PROJECTION.lon(x), PROJECTION.lat(y)] for x, y in points_m]
    if coords[0] != coords[-1]:
        coords.append(list(coords[0]))
    return coords


def rect(x0, y0, x1, y1) -> list[list[float]]:
    return ring([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])


def polygon(*rings) -> dict:
    return {"type": "Polygon", "coordinates": list(rings)}


def multipolygon(*polygons) -> dict:
    """Each argument is a list of rings (outer first)."""
    return {"type": "MultiPolygon", "coordinates": list(polygons)}


def building(building_id: str, geometry: dict, floors: str | None = "3", **extra) -> dict:
    return {"id": building_id, "groundFloorRaw": floors, "geometry": geometry, **extra}


def request(buildings: list[dict], radius: int = 100, complete: bool = True, reasons: list[dict] | None = None,
            **extra) -> dict:
    if reasons is None:
        reasons = [] if complete else [{"code": "PAGE_LIMIT", "message": "조회 한도를 넘었습니다."}]
    return {"center": dict(CENTER), "radiusMeters": radius, "complete": complete, "incompleteReasons": reasons,
            "buildings": buildings, **extra}


def rect_in_disk_area(r: float, x0: float, x1: float, h: float) -> float:
    """Exact area of [x0, x1] x [-h, h] intersected with the disk of radius r around the origin (0 <= x0)."""

    def s(x):
        return math.sqrt(max(r * r - x * x, 0.0))

    def arc(a, b):  # integral of sqrt(r² - x²) from a to b
        f = lambda x: (x * s(x) + r * r * math.asin(max(-1.0, min(1.0, x / r)))) / 2
        return f(b) - f(a)

    x1 = min(x1, r)
    if x1 <= x0:
        return 0.0
    xh = math.sqrt(max(r * r - h * h, 0.0))  # where the circle leaves the rectangle height
    flat_end = min(max(x0, xh), x1)
    return 2 * (h * (flat_end - x0) + arc(flat_end, x1))
