"""Checks real Java radius analysis results saved by hand in tests/fixtures/real/*.json.

That folder is excluded from Git (real addresses and building names). Without files these tests are skipped.
Save the JSON body of GET /api/buildings/nearby or GET /api/analyses/{id} there to run them.
"""

import json
from pathlib import Path

import pytest

from app.schemas.building_stats import BuildingStatsRequest
from app.services.building_stats import compute_building_stats
from tests.java_result import to_request

REAL = Path(__file__).parent / "fixtures" / "real"
FILES = sorted(REAL.glob("*.json")) if REAL.is_dir() else []


@pytest.mark.skipif(not FILES, reason="no real Java results in tests/fixtures/real (not tracked by Git)")
@pytest.mark.parametrize("path", FILES, ids=[p.name for p in FILES])
def test_real_java_result_matches(path):
    java = json.loads(path.read_text(encoding="utf-8"))
    detail = java.get("result", java)
    result = compute_building_stats(BuildingStatsRequest.model_validate(to_request(java)))
    floors = detail["floorStatistics"]

    assert result.counts.total == detail["summary"]["intersecting"]
    assert result.counts.relation_mismatch == 0
    assert result.counts.distance_mismatch == 0
    assert result.counts.excluded == 0 or all(e.reason != "OUTSIDE_RADIUS" for e in result.excluded)
    assert (result.floors.with_data, result.floors.without_data) == (floors["withData"], floors["withoutData"])
    assert (result.floors.min, result.floors.max, result.floors.average) == (floors["min"], floors["max"],
                                                                             floors["average"])
    assert result.completeness.complete == detail["complete"]
    assert ("PARTIAL_RESULT" in {w.code for w in result.warnings}) == (not detail["complete"])


def test_mapping_accepts_both_java_response_shapes():
    """The mapping itself, on a synthetic body shaped like RadiusAnalysisResult / AnalysisDetail."""
    from tests.factories import CENTER, rect

    live = {
        "center": CENTER, "radiusMeters": 100, "complete": True, "incompleteReasons": [],
        "summary": {"intersecting": 1, "inside": 1, "partial": 0, "outsideExcluded": 0, "geometryUnavailable": 0,
                    "distinctBuildings": 1, "mergedDuplicateFeatures": 0},
        "floorStatistics": {"withData": 1, "withoutData": 0, "min": 3, "max": 3, "average": 3.0, "distribution": []},
        "buildings": [{"id": "bd:1", "building": {"groundFloorCount": "3"}, "relation": "INSIDE",
                       "distanceMeters": 10.0, "centerInside": False, "hasHoles": False,
                       "polygons": [[rect(10, -5, 30, 5)]]}],
        "analysisToken": "x", "analyzedAt": "2026-10-11T00:00:00Z",
    }
    saved = {"analysisId": 3, "title": "t", "analyzedAt": "2026-10-11T00:00:00Z", "result": live}

    for body, kind in ((live, "LIVE"), (saved, "SAVED")):
        result = compute_building_stats(BuildingStatsRequest.model_validate(to_request(body)))
        assert result.source.kind == kind
        assert result.counts.total == 1 and result.counts.relation_mismatch == 0
        assert result.counts.distance_mismatch == 0
