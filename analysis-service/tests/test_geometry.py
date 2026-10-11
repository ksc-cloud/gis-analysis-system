import math

import numpy as np
import pytest

from app.geo.geometry import (CIRCLE_SEGMENTS, Footprint, FootprintFailure, GeometryIssue, build_footprint, circle,
                              circle_error)


def sq(x0, y0, x1, y1):
    return np.array([(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)], dtype=float)


def test_polygon_with_hole_excludes_hole_area():
    footprint = build_footprint([[sq(0, 0, 20, 20), sq(5, 5, 10, 10)]])

    assert isinstance(footprint, Footprint)
    assert footprint.area == pytest.approx(400 - 25)
    assert footprint.repaired is False


def test_multipolygon_parts_overlap_counts_once_and_is_reported():
    footprint = build_footprint([[sq(0, 0, 10, 10)], [sq(5, 0, 15, 10)]])

    assert footprint.area == pytest.approx(150)
    assert footprint.parts_area == pytest.approx(200)
    assert footprint.internal_overlap_area == pytest.approx(50)
    assert footprint.repaired is False


def test_multipolygon_parts_touching_have_no_overlap():
    footprint = build_footprint([[sq(0, 0, 10, 10)], [sq(10, 0, 20, 10)]])

    assert footprint.area == pytest.approx(200)
    assert footprint.internal_overlap_area == 0


def test_self_intersecting_polygon_is_repaired():
    bowtie = np.array([(0, 0), (10, 10), (10, 0), (0, 10), (0, 0)], dtype=float)
    footprint = build_footprint([[bowtie]])

    assert isinstance(footprint, Footprint)
    assert footprint.repaired is True
    assert footprint.repair_reasons == ("Self-intersection",)
    assert footprint.area == pytest.approx(50)


def test_collapsed_polygon_cannot_be_repaired():
    line = np.array([(0, 0), (10, 0), (20, 0), (0, 0)], dtype=float)
    failure = build_footprint([[line]])

    assert isinstance(failure, FootprintFailure)
    assert failure.issue == GeometryIssue.INVALID_GEOMETRY


def test_tiny_polygon_has_zero_area():
    failure = build_footprint([[sq(0, 0, 0.05, 0.05)]])

    assert isinstance(failure, FootprintFailure)
    assert failure.issue == GeometryIssue.ZERO_AREA


@pytest.mark.parametrize("radius", [50, 100, 200, 500, 1000])
def test_circle_error_is_about_one_in_ten_thousand(radius):
    error = circle_error(radius)

    assert CIRCLE_SEGMENTS == 256
    assert error.exact_area == pytest.approx(math.pi * radius ** 2)
    assert error.polygon_area == pytest.approx(circle(radius).area)
    assert error.area_error_ratio == pytest.approx(1.004e-4, rel=1e-3)
    assert error.max_radial_gap_meters == pytest.approx(radius * 7.53e-5, rel=1e-3)
