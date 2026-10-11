import json

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from tests.factories import AUTH, TOKEN, building, polygon, rect, request

URL = "/internal/v1/hotspot"
GRID_URL = "/internal/v1/grid-density"
STATS_URL = "/internal/v1/building-stats"


def valid_payload(**extra) -> dict:
    buildings = [building(f"bd:{i}", polygon(rect(100 + (i % 5) * 10, 100 + (i // 5) * 10,
                                                  108 + (i % 5) * 10, 108 + (i // 5) * 10))) for i in range(25)]
    return request(buildings, radius=300, **{"cellSizeMeters": 50, **extra})


def post(client, payload, headers=None, url=URL):
    return client.post(url, json=payload, headers=AUTH if headers is None else headers)


def keys(value) -> set[str]:
    """Every object key in a JSON document, except the keys of the class and reason count maps."""
    found = set()
    if isinstance(value, dict):
        for key, item in value.items():
            found.add(key)
            if key not in ("classes", "notTestedReasons"):
                found |= keys(item)
    elif isinstance(value, list):
        for item in value:
            found |= keys(item)
    return found


# ----------------------------------------------------------------------------------------- response

def test_valid_request_returns_hotspot_cells(internal_client):
    response = post(internal_client, valid_payload())
    body = response.json()
    cell = next(f for f in body["cells"]["features"] if f["id"] == "2:2")

    assert response.status_code == 200
    assert body["schemaVersion"] == 1 and body["status"] == "OK" and body["blockedReasons"] == []
    assert body["cellSizeMeters"] == 50 and body["radiusMeters"] == 300
    assert body["cells"]["type"] == "FeatureCollection" and len(body["cells"]["features"]) == 137
    assert cell["type"] == "Feature" and cell["geometry"]["type"] == "Polygon"
    assert set(cell["properties"]) == {"col", "row", "centerLon", "centerLat", "boundary", "smallBoundary",
                                       "domainRatio", "coverageRatio", "neighborCount", "giZ", "pValue", "qValue",
                                       "hotspotClass", "bin", "reason"}
    assert cell["properties"]["hotspotClass"] == "HOT_99" and cell["properties"]["bin"] == 3
    assert set(body["moran"]) == {"i", "expected", "pValue", "zSimulated", "simulatedMean", "simulatedSd"}
    assert body["method"]["permutations"] == 999 and body["method"]["seed"] == 20261012
    assert body["completeness"]["complete"] is True and body["completeness"]["sourceComplete"] is True
    assert body["summary"]["classes"]["HOT_99"] >= 1


def test_response_is_camel_case_without_simulations(internal_client):
    response = post(internal_client, valid_payload())
    body = response.json()

    assert all("_" not in key for key in keys(body)), sorted(k for k in keys(body) if "_" in k)
    assert "simulated" not in response.text.replace("simulatedMean", "").replace("simulatedSd", "")
    assert set(body["summary"]["classes"]) == {"HOT_99", "HOT_95", "HOT_90", "NOT_SIGNIFICANT", "COLD_90",
                                               "COLD_95", "COLD_99", "NOT_TESTED"}


def test_untested_cells_have_null_statistics_in_json(internal_client):
    body = post(internal_client, valid_payload()).json()
    small = [f["properties"] for f in body["cells"]["features"] if f["properties"]["smallBoundary"]]

    assert small and all(p["giZ"] is None and p["pValue"] is None and p["qValue"] is None and p["bin"] is None
                         and p["neighborCount"] is None and p["reason"] == "SMALL_BOUNDARY" for p in small)


def test_options(internal_client):
    body = post(internal_client, valid_payload(permutations=99, seed=0, cellSizeMeters=100)).json()

    assert body["method"]["permutations"] == 99 and body["method"]["seed"] == 0
    assert body["cellSizeMeters"] == 100 and body["grid"]["cellArea"] == 10000


def test_partial_result_is_blocked_with_200(internal_client):
    response = post(internal_client, valid_payload(complete=False, incompleteReasons=[
        {"code": "PAGE_LIMIT", "message": "조회 한도"}, {"code": "NEW_CODE", "message": "새 사유"}]))
    body = response.json()

    assert response.status_code == 200
    assert body["status"] == "PARTIAL_RESULT_BLOCKED" and body["blockedReasons"] == ["PAGE_LIMIT", "NEW_CODE"]
    assert body["grid"] is None and body["counts"] is None and body["moran"] is None
    assert body["cells"] == {"type": "FeatureCollection", "features": []}
    assert body["completeness"]["complete"] is False and body["completeness"]["sourceComplete"] is False
    assert [w["code"] for w in body["warnings"]] == ["PARTIAL_RESULT_BLOCKED"]


# ----------------------------------------------------------------------------------------- validation

@pytest.mark.parametrize("value", [0, 100, 1000, -999, 10000, "999", 999.0, True, None])
def test_invalid_permutations(internal_client, value):
    response = post(internal_client, valid_payload(permutations=value))

    assert response.status_code == 422 and response.json()["error"] == "VALIDATION_ERROR"
    assert any(d["loc"] == "body.permutations" for d in response.json()["details"])


@pytest.mark.parametrize("value", [-1, 2**31, 2**40, 1.5, 7.0, "1", True, None])
def test_invalid_seed(internal_client, value):
    response = post(internal_client, valid_payload(seed=value))

    assert response.status_code == 422
    assert any(d["loc"] == "body.seed" for d in response.json()["details"])


@pytest.mark.parametrize("value", [0, 2**31 - 1])
def test_seed_bounds_are_allowed(internal_client, value):
    assert post(internal_client, valid_payload(seed=value)).status_code == 200


@pytest.mark.parametrize("size", [75, 0, -50, 400, "100", 100.0, True, None])
def test_invalid_cell_size(internal_client, size):
    response = post(internal_client, {**valid_payload(), "cellSizeMeters": size})

    assert response.status_code == 422
    assert any(d["loc"] == "body.cellSizeMeters" for d in response.json()["details"])


def test_cell_size_is_required(internal_client):
    payload = valid_payload()
    del payload["cellSizeMeters"]

    assert post(internal_client, payload).status_code == 422


@pytest.mark.parametrize("field", ["includeEmptyCells", "includeCellBuildingIds", "includeBuildings", "unknown"])
def test_grid_and_unknown_options_are_rejected(internal_client, field):
    response = post(internal_client, valid_payload(**{field: True}))

    assert response.status_code == 422
    assert any(d["loc"] == f"body.{field}" and d["type"] == "extra_forbidden" for d in response.json()["details"])


@pytest.mark.parametrize(("complete", "reasons"), [(False, []), (True, [{"code": "PAGE_LIMIT", "message": "x"}])])
def test_complete_and_reasons_must_agree(internal_client, complete, reasons):
    response = post(internal_client, valid_payload(complete=complete, incompleteReasons=reasons))

    assert response.status_code == 422 and response.json()["error"] == "VALIDATION_ERROR"


def test_invalid_json(internal_client):
    response = internal_client.post(URL, content=b"{", headers={**AUTH, "Content-Type": "application/json"})

    assert response.status_code == 400 and response.json()["error"] == "INVALID_JSON"


# ----------------------------------------------------------------------------------------- guard

def test_token_not_configured_returns_503(client):
    response = post(client, valid_payload())

    assert response.status_code == 503 and response.json()["error"] == "INTERNAL_TOKEN_NOT_CONFIGURED"


@pytest.mark.parametrize("headers", [{}, {"X-Internal-Token": "wrong"}, {"Authorization": f"Bearer {TOKEN}"}])
def test_missing_or_wrong_token_returns_401(internal_client, headers):
    response = post(internal_client, valid_payload(), headers=headers)

    assert response.status_code == 401
    assert response.json() == {"error": "UNAUTHORIZED", "message": "내부 인증 토큰이 없거나 올바르지 않습니다."}


def test_content_type_and_size_limits():
    with TestClient(create_app(Settings(internal_token=TOKEN, max_body_bytes=2048))) as c:
        too_large = c.post(URL, content=b"{" + b" " * 3000 + b"}",
                           headers={**AUTH, "Content-Type": "application/json"})
        chunked = c.post(URL, content=iter([b"{", b" " * 3000, b"}"]),
                         headers={**AUTH, "Content-Type": "application/json"})
        text = c.post(URL, content=json.dumps(valid_payload()), headers={**AUTH, "Content-Type": "text/plain"})

    assert too_large.status_code == 413 and too_large.json()["error"] == "PAYLOAD_TOO_LARGE"
    assert chunked.status_code == 413
    assert text.status_code == 415


def test_the_compare_body_limit_does_not_apply():
    """Only compare-analyses uses the larger limit; the hotspot path uses ANALYSIS_MAX_BODY_BYTES."""
    with TestClient(create_app(Settings(internal_token=TOKEN, max_body_bytes=2048,
                                        compare_max_body_bytes=10_000_000))) as c:
        response = c.post(URL, content=json.dumps(valid_payload()),
                          headers={**AUTH, "Content-Type": "application/json"})

    assert response.status_code == 413


# ----------------------------------------------------------------------------------------- OpenAPI

def openapi(client) -> dict:
    response = client.get("/openapi.json")
    assert response.status_code == 200
    return response.json()


def test_openapi_documents_the_hotspot_endpoint(client):
    schema = openapi(client)
    operation = schema["paths"][URL]["post"]
    schemas = schema["components"]["schemas"]

    assert operation["requestBody"]["required"] is True
    assert operation["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/HotspotRequest"}
    assert operation["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/HotspotResponse"}
    assert {"401", "413", "415", "422", "503"} <= set(operation["responses"])
    assert operation["security"] == [{"InternalToken": []}]
    refs = {part.split('"')[0] for part in json.dumps(schema).split('"$ref": "#/components/schemas/')[1:]}
    assert refs <= set(schemas)


def test_openapi_hotspot_request_schema(client):
    hotspot = openapi(client)["components"]["schemas"]["HotspotRequest"]
    properties = hotspot["properties"]

    assert properties["cellSizeMeters"]["enum"] == [50, 100, 200]
    assert properties["permutations"]["enum"] == [99, 999, 9999] and properties["permutations"]["default"] == 999
    assert properties["seed"]["minimum"] == 0 and properties["seed"]["maximum"] == 2**31 - 1
    assert properties["seed"]["default"] == 20261012
    assert "includeEmptyCells" not in properties and "includeCellBuildingIds" not in properties
    assert {"center", "radiusMeters", "complete", "buildings", "cellSizeMeters"} <= set(hotspot["required"])
    assert hotspot["additionalProperties"] is False


# ----------------------------------------------------------------------------------------- other endpoints

def test_existing_endpoints_still_answer(internal_client):
    base = {k: v for k, v in valid_payload().items() if k != "cellSizeMeters"}
    stats = post(internal_client, base, url=STATS_URL)
    grid = post(internal_client, {**base, "cellSizeMeters": 50}, url=GRID_URL)
    hotspot = post(internal_client, valid_payload()).json()

    assert stats.status_code == 200 and "withinRadius" in stats.json()
    assert grid.status_code == 200 and len(grid.json()["cells"]["features"]) == 137
    grid_cells = grid.json()["cells"]["features"]
    assert [f["id"] for f in hotspot["cells"]["features"]] == [f["id"] for f in grid_cells]
    assert [f["geometry"] for f in hotspot["cells"]["features"]] == [f["geometry"] for f in grid_cells]
    assert "hotspotClass" not in grid_cells[0]["properties"]  # grid-density response unchanged
    assert post(internal_client, {**base, "cellSizeMeters": 50, "permutations": 999}, url=GRID_URL).status_code == 422


def test_existing_openapi_paths_are_kept(client):
    paths = openapi(client)["paths"]

    assert {STATS_URL, GRID_URL, "/internal/v1/compare-analyses", URL} <= set(paths)
