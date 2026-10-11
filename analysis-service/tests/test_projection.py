import json
import math
from pathlib import Path

import pytest

from app.geo.projection import TOLERANCE_METERS, LocalProjection, Relation, evaluate

DATA = Path(__file__).parent / "data" / "java_planar_geometry_cases.json"


def project(projection, polygons_lon_lat):
    return [[projection.project_ring(ring) for ring in rings] for rings in polygons_lon_lat]


def square(x0, y0, x1, y1):
    import numpy as np
    return np.array([(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)], dtype=float)


@pytest.mark.parametrize("lat", [33.0, 35.0, 37.5, 39.0])
def test_meters_per_degree_match_reference_series(lat):
    """Independent reference: standard WGS84 series for the length of one degree (accurate to ~1 cm)."""
    phi = math.radians(lat)
    lat_degree = 111132.92 - 559.82 * math.cos(2 * phi) + 1.175 * math.cos(4 * phi) - 0.0023 * math.cos(6 * phi)
    lon_degree = 111412.84 * math.cos(phi) - 93.5 * math.cos(3 * phi) + 0.118 * math.cos(5 * phi)
    projection = LocalProjection(127.0, lat)

    assert projection.y(lat + 1) - projection.y(lat) == pytest.approx(lat_degree, abs=0.05)
    assert projection.x(128.0) - projection.x(127.0) == pytest.approx(lon_degree, abs=0.05)


def test_round_trip_and_center_is_origin():
    projection = LocalProjection(126.978, 37.5665)

    assert projection.x(126.978) == 0 and projection.y(37.5665) == 0
    assert projection.lon(projection.x(126.99)) == pytest.approx(126.99, abs=1e-12)
    assert projection.lat(projection.y(37.57)) == pytest.approx(37.57, abs=1e-12)


def test_matches_real_java_planar_geometry():
    """Expected values were produced by the compiled Java PlanarGeometry.evaluate on the same synthetic data."""
    cases = json.loads(DATA.read_text(encoding="utf-8"))["cases"]
    assert len(cases) >= 16
    for case in cases:
        projection = LocalProjection(case["center"]["lon"], case["center"]["lat"])
        result = evaluate(project(projection, case["polygons"]), case["radiusMeters"])
        java = case["java"]

        assert result.relation == java["relation"], case["id"]
        assert result.center_inside == java["centerInside"], case["id"]
        assert result.distance_meters == pytest.approx(java["distanceMeters"], abs=1e-9), case["id"]


def test_inside_requires_every_outer_vertex_within_radius_plus_tolerance():
    import numpy as np
    r = 100

    def wedge(tip):
        return np.array([(10, -5), (tip, 0), (10, 5), (10, -5)], dtype=float)

    assert evaluate([[wedge(r + 0.0009)]], r).relation == Relation.INSIDE
    assert evaluate([[wedge(r + 0.0011)]], r).relation == Relation.PARTIAL


def test_partial_and_outside_boundary_uses_one_millimeter_tolerance():
    r = 100
    touching = evaluate([[square(r + TOLERANCE_METERS * 0.9, -5, r + 10, 5)]], r)
    apart = evaluate([[square(r + TOLERANCE_METERS * 1.1, -5, r + 10, 5)]], r)

    assert touching.relation == Relation.PARTIAL
    assert touching.distance_meters == pytest.approx(r + 0.0009)
    assert apart.relation == Relation.OUTSIDE


def test_center_inside_footprint_has_distance_zero():
    result = evaluate([[square(-5, -5, 5, 5)]], 50)

    assert result.relation == Relation.INSIDE
    assert result.center_inside is True
    assert result.distance_meters == 0


def test_center_in_hole_is_outside_the_building():
    outer = square(-30, -30, 30, 30)
    hole = square(-10, -10, 10, 10)[::-1]
    result = evaluate([[outer, hole]], 40)

    assert result.center_inside is False
    assert result.distance_meters == pytest.approx(10)
    assert result.relation == Relation.PARTIAL  # outer corners are 42.4 m away
    assert evaluate([[outer, hole]], 5).relation == Relation.OUTSIDE  # the circle lies in the hole


def test_multipolygon_distance_is_minimum_and_inside_needs_all_parts():
    near = square(10, -5, 20, 5)
    far = square(200, -5, 210, 5)
    result = evaluate([[far], [near]], 100)

    assert result.distance_meters == pytest.approx(10)
    assert result.relation == Relation.PARTIAL


def test_polygons_required():
    with pytest.raises(ValueError):
        evaluate([], 100)
