import json
import time

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from tests.factories import AUTH, TOKEN, building, polygon, rect, request

URL = "/internal/v1/grid-density"
STATS_URL = "/internal/v1/building-stats"


def valid_payload(**extra) -> dict:
    return request([building("bd:1", polygon(rect(-10, -10, 10, 10)))], cellSizeMeters=50, **extra)


def post(client, payload, headers=None, url=URL):
    return client.post(url, json=payload, headers=AUTH if headers is None else headers)


# ----------------------------------------------------------------------------------------- response

def test_valid_request_returns_geojson_cells(internal_client):
    response = post(internal_client, valid_payload())
    body = response.json()
    feature = next(f for f in body["cells"]["features"] if f["id"] == "0:0")

    assert response.status_code == 200
    assert body["schemaVersion"] == 1 and body["cellSizeMeters"] == 50
    assert body["cells"]["type"] == "FeatureCollection"
    assert feature["type"] == "Feature" and feature["geometry"]["type"] == "Polygon"
    assert len(feature["geometry"]["coordinates"][0]) == 5
    assert feature["properties"]["buildingCount"] == 1 and feature["properties"]["primaryBuildingCount"] == 1
    assert feature["properties"]["occupiedArea"] == pytest.approx(400, abs=0.01)
    assert feature["properties"]["buildingIds"] is None
    assert body["consistency"]["occupiedAreaMatches"] is True
    assert body["grid"]["cellCount"] == len(body["cells"]["features"]) == 21


def test_options(internal_client):
    body = post(internal_client, valid_payload(includeEmptyCells=False, includeCellBuildingIds=True)).json()

    assert [f["id"] for f in body["cells"]["features"]] == ["0:0"]
    assert body["cells"]["features"][0]["properties"]["buildingIds"] == ["bd:1"]


@pytest.mark.parametrize("size", [50, 100, 200])
def test_allowed_cell_sizes(internal_client, size):
    response = post(internal_client, {**valid_payload(), "cellSizeMeters": size})

    assert response.status_code == 200
    assert response.json()["grid"]["cellArea"] == size * size


@pytest.mark.parametrize("size", [75, 0, -50, 400, "100", 100.0, 100.5, True, None])
def test_invalid_cell_size(internal_client, size):
    response = post(internal_client, {**valid_payload(), "cellSizeMeters": size})

    assert response.status_code == 422
    assert response.json()["error"] == "VALIDATION_ERROR"
    assert response.json()["details"][0]["loc"] == "body.cellSizeMeters"


def test_cell_size_is_required(internal_client):
    payload = valid_payload()
    del payload["cellSizeMeters"]
    response = post(internal_client, payload)

    assert response.status_code == 422
    assert response.json()["details"][0]["loc"] == "body.cellSizeMeters"


@pytest.mark.parametrize("field", ["includeEmptyCells", "includeCellBuildingIds"])
def test_flags_must_be_booleans(internal_client, field):
    assert post(internal_client, {**valid_payload(), field: "true"}).status_code == 422


def test_building_stats_fields_are_not_grid_fields(internal_client):
    # Each endpoint keeps its own contract: unknown fields are rejected on both.
    assert post(internal_client, valid_payload(includeBuildings=True)).status_code == 422
    stats_payload = {k: v for k, v in valid_payload().items()}
    assert post(internal_client, stats_payload, url=STATS_URL).status_code == 422
    del stats_payload["cellSizeMeters"]
    assert post(internal_client, stats_payload, url=STATS_URL).status_code == 200


def test_shared_request_validation(internal_client):
    duplicate = request([building("bd:1", polygon(rect(0, 0, 10, 10))),
                         building("bd:1", polygon(rect(20, 0, 30, 10)))], cellSizeMeters=50)
    response = post(internal_client, duplicate)
    assert response.status_code == 422 and response.json()["error"] == "DUPLICATE_BUILDING_ID"

    assert post(internal_client, {**valid_payload(), "radiusMeters": 1001}).status_code == 422
    assert post(internal_client, {**valid_payload(), "complete": False}).status_code == 422
    response = internal_client.post(URL, content=b"{bad", headers={**AUTH, "Content-Type": "application/json"})
    assert response.status_code == 400 and response.json()["error"] == "INVALID_JSON"


# ----------------------------------------------------------------------------------------- guard

def test_token_not_configured_returns_503(client):
    response = post(client, valid_payload())

    assert response.status_code == 503
    assert response.json()["error"] == "INTERNAL_TOKEN_NOT_CONFIGURED"


@pytest.mark.parametrize("headers", [{}, {"X-Internal-Token": "wrong"}, {"Authorization": f"Bearer {TOKEN}"}])
def test_missing_or_wrong_token_returns_401(internal_client, headers):
    response = post(internal_client, valid_payload(), headers=headers)

    assert response.status_code == 401
    assert response.json() == {"error": "UNAUTHORIZED", "message": "내부 인증 토큰이 없거나 올바르지 않습니다."}


def test_content_type_and_size_limits():
    with TestClient(create_app(Settings(internal_token=TOKEN, max_body_bytes=2048))) as c:
        too_large = c.post(URL, content=b"{" + b" " * 3000 + b"}",
                           headers={**AUTH, "Content-Type": "application/json"})
        text = c.post(URL, content=json.dumps(valid_payload()), headers={**AUTH, "Content-Type": "text/plain"})

    assert too_large.status_code == 413 and too_large.json()["error"] == "PAYLOAD_TOO_LARGE"
    assert text.status_code == 415


# ----------------------------------------------------------------------------------------- OpenAPI

def openapi(client) -> dict:
    response = client.get("/openapi.json")
    assert response.status_code == 200
    return response.json()


@pytest.mark.parametrize(("path", "request_model", "response_model"), [
    (STATS_URL, "BuildingStatsRequest", "BuildingStatsResponse"),
    (URL, "GridDensityRequest", "GridDensityResponse")])
def test_openapi_documents_both_internal_endpoints(client, path, request_model, response_model):
    schema = openapi(client)
    operation = schema["paths"][path]["post"]
    schemas = schema["components"]["schemas"]

    assert operation["requestBody"]["required"] is True
    assert operation["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": f"#/components/schemas/{request_model}"}
    assert operation["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": f"#/components/schemas/{response_model}"}
    assert {"401", "413", "415", "422", "503"} <= set(operation["responses"])
    assert operation["security"] == [{"InternalToken": []}]
    assert request_model in schemas and response_model in schemas
    # Every reference resolves.
    refs = {part.split('"')[0] for part in json.dumps(schema).split('"$ref": "#/components/schemas/')[1:]}
    assert refs <= set(schemas)


def test_openapi_request_schemas(client):
    schemas = openapi(client)["components"]["schemas"]
    grid = schemas["GridDensityRequest"]
    stats = schemas["BuildingStatsRequest"]

    assert grid["properties"]["cellSizeMeters"]["enum"] == [50, 100, 200]
    assert grid["properties"]["includeEmptyCells"]["default"] is True
    assert grid["properties"]["includeCellBuildingIds"]["default"] is False
    assert {"center", "radiusMeters", "complete", "buildings", "cellSizeMeters"} <= set(grid["required"])
    assert grid["additionalProperties"] is False
    assert "includeBuildings" in stats["properties"] and "cellSizeMeters" not in stats["properties"]
    assert stats["properties"]["source"]["anyOf"][0]["$ref"].endswith("/Source-Input")


def test_openapi_security_scheme_documents_the_header_only(client):
    schema = openapi(client)

    assert schema["components"]["securitySchemes"] == {"InternalToken": {
        "type": "apiKey", "in": "header", "name": "X-Internal-Token",
        "description": schema["components"]["securitySchemes"]["InternalToken"]["description"]}}
    assert "security" not in schema["paths"]["/health"]["get"]
    assert "security" not in schema  # no global requirement


def test_openapi_is_public_and_does_not_change_auth(internal_client):
    schema_text = internal_client.get("/openapi.json").text

    assert TOKEN not in schema_text
    assert internal_client.get("/docs").status_code == 200
    assert post(internal_client, valid_payload(), headers={}).status_code == 401
    assert post(internal_client, valid_payload()).status_code == 200


def test_internal_api_works_with_docs_disabled():
    with TestClient(create_app(Settings(internal_token=TOKEN, docs_enabled=False))) as c:
        assert c.get("/openapi.json").status_code == 404
        assert post(c, valid_payload()).status_code == 200
        assert post(c, valid_payload(), headers={}).status_code == 401


# ----------------------------------------------------------------------------------------- end to end

@pytest.mark.parametrize("size", [50, 200])
def test_5000_buildings_end_to_end(internal_client, size):
    buildings = []
    for i in range(5000):
        x = -1050 + (i % 75) * 28.0
        y = -1050 + (i // 75) * 28.0
        buildings.append(building(f"bd:{i:05d}", polygon(rect(x, y, x + 20, y + 15)), floors=str(i % 30)))
    body = json.dumps(request(buildings, radius=1000, cellSizeMeters=size)).encode()

    started = time.perf_counter()
    response = internal_client.post(URL, content=body, headers={**AUTH, "Content-Type": "application/json"})
    elapsed = time.perf_counter() - started
    print(f"\n5000 buildings grid {size} m end to end: {len(body) / 1024 / 1024:.2f} MiB request, "
          f"{len(response.content) / 1024:.0f} KiB response, {elapsed:.3f}s")

    assert response.status_code == 200
    result = response.json()
    assert result["counts"]["total"] == 5000
    assert result["consistency"]["occupiedAreaMatches"] and result["consistency"]["primaryMatchesAnalyzed"]
    assert elapsed < 10
