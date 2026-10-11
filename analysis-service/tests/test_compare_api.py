import json
import math
import time

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from tests.factories import AUTH, TOKEN, building, polygon, ring
from tests.test_compare import city, payload, square

URL = "/internal/v1/compare-analyses"
OTHER_URLS = ["/internal/v1/building-stats", "/internal/v1/grid-density"]
MIB = 1024 * 1024


def valid_payload(**options) -> dict:
    return payload([square("bd:1", 0), square("bd:2", 20)], [square("bd:1", 0, floors="5"), square("bd:3", 40)],
                   **options)


def post(client, data, headers=None):
    return client.post(URL, json=data, headers=AUTH if headers is None else headers)


def post_raw(client, url, body, headers=None):
    return client.post(url, content=body, headers={**AUTH, "Content-Type": "application/json", **(headers or {})})


def padded(data: dict, size: int) -> bytes:
    """Valid JSON of exactly ``size`` bytes (trailing whitespace)."""
    body = json.dumps(data).encode()
    return body + b" " * (size - len(body))


# ----------------------------------------------------------------------------------------- response

def test_valid_request(internal_client):
    response = post(internal_client, valid_payload())
    body = response.json()

    assert response.status_code == 200
    assert body["comparable"] is True and body["comparisonBasis"] == "CHANGE"
    assert body["before"]["source"]["analysisId"] == 1 and body["after"]["source"]["analysisId"] == 2
    assert body["statistics"]["buildingCount"] == {"unit": "count", "before": 2, "after": 2, "delta": 0,
                                                   "changeRate": 0.0}
    assert body["statistics"]["coverageRatio"]["deltaPercentPoint"] == 0
    assert {c["id"]: c["status"] for c in body["buildings"]["changes"]} == {
        "bd:1": "MODIFIED", "bd:2": "REMOVED", "bd:3": "ADDED"}
    assert body["method"]["centerToleranceMeters"] == 0.05
    assert body["method"]["analysis"]["circleSegments"] == 256


def test_not_comparable_is_200(internal_client):
    data = valid_payload()
    data["after"]["radiusMeters"] = 200
    body = post(internal_client, data).json()

    assert body["comparable"] is False and body["statistics"] is None and body["buildings"] is None
    assert body["notComparableReasons"][0]["code"] == "RADIUS_DIFFERENT"


def test_options(internal_client):
    defaults = post(internal_client, valid_payload()).json()["buildings"]
    unchanged = post(internal_client, valid_payload(includeUnchanged=True)).json()["buildings"]
    summary_only = post(internal_client, valid_payload(includeBuildingChanges=False)).json()["buildings"]

    assert all(c["status"] != "UNCHANGED" for c in defaults["changes"])
    assert unchanged["summary"] == defaults["summary"]
    assert summary_only["changes"] is None and summary_only["summary"]["added"] == 1


@pytest.mark.parametrize(("change", "error"), [
    ({"after": {"analysisId": 1}}, "SAME_ANALYSIS"),
    ({"before": {"analyzedAt": "2026-12-01T00:00:00Z"}}, "ANALYSIS_ORDER_REVERSED")])
def test_order_and_identity_errors(internal_client, change, error):
    data = valid_payload()
    for side, values in change.items():
        data[side]["source"].update(values)
    response = post(internal_client, data)

    assert response.status_code == 422 and response.json()["error"] == error


def test_shared_request_validation(internal_client):
    data = valid_payload()
    data["after"]["buildings"].append(dict(data["after"]["buildings"][0]))
    duplicate = post(internal_client, data)
    assert duplicate.status_code == 422 and duplicate.json()["error"] == "DUPLICATE_BUILDING_ID"
    assert duplicate.json()["details"][0]["loc"].startswith("body.after")

    for side, field, value in [("before", "radiusMeters", 1001), ("after", "complete", "yes"),
                               ("before", "unknown", 1), ("after", "dataSource", None)]:
        data = valid_payload()
        data[side][field] = value
        assert post(internal_client, data).status_code == 422
    for field in ("includeUnchanged", "includeBuildingChanges"):
        assert post(internal_client, {**valid_payload(), field: "true"}).status_code == 422
    assert post(internal_client, {**valid_payload(), "includeBuildings": True}).status_code == 422


def test_errors_do_not_echo_geometry(internal_client):
    data = valid_payload()
    data["after"]["buildings"][0]["geometry"]["coordinates"][0][1][1] = 95.0
    data["before"]["source"]["analyzedAt"] = "2027-01-01T00:00:00Z"
    response = post(internal_client, data)

    assert response.status_code == 422
    assert "127.0" not in response.text and "37.5" not in response.text
    assert all("input" not in d for d in response.json()["details"])


# ----------------------------------------------------------------------------------------- guard

def test_token_not_configured_returns_503(client):
    assert post(client, valid_payload()).json()["error"] == "INTERNAL_TOKEN_NOT_CONFIGURED"


@pytest.mark.parametrize("headers", [{}, {"X-Internal-Token": "wrong"}, {"Authorization": f"Bearer {TOKEN}"}])
def test_missing_or_wrong_token_returns_401(internal_client, headers):
    response = post(internal_client, valid_payload(), headers=headers)

    assert response.status_code == 401
    assert response.json() == {"error": "UNAUTHORIZED", "message": "내부 인증 토큰이 없거나 올바르지 않습니다."}


def test_auth_is_checked_before_the_size_limit(internal_client):
    response = internal_client.post(URL, content=b"{" + b" " * (40 * MIB) + b"}",
                                    headers={"Content-Type": "application/json"})

    assert response.status_code == 401


def test_content_type_must_be_json(internal_client):
    response = internal_client.post(URL, content=json.dumps(valid_payload()),
                                    headers={**AUTH, "Content-Type": "text/plain"})

    assert response.status_code == 415


# ----------------------------------------------------------------------------------------- size limits

def test_default_limits():
    settings = Settings.from_env({})

    assert settings.max_body_bytes == 16 * MIB and settings.compare_max_body_bytes == 32 * MIB
    assert Settings.from_env({"ANALYSIS_COMPARE_MAX_BODY_BYTES": "4096"}).compare_max_body_bytes == 4096
    assert "compare_max_body_bytes=33554432" in repr(settings)


@pytest.mark.parametrize("value", ["abc", "100", str(64 * MIB + 1)])
def test_invalid_compare_limit_is_rejected(value):
    with pytest.raises(ValueError, match="ANALYSIS_COMPARE_MAX_BODY_BYTES"):
        Settings.from_env({"ANALYSIS_COMPARE_MAX_BODY_BYTES": value})


def test_compare_accepts_bodies_between_16_and_32_mib(internal_client):
    body = padded(valid_payload(), 24 * MIB)
    response = post_raw(internal_client, URL, body)

    assert response.status_code == 200 and response.json()["comparable"] is True


@pytest.mark.parametrize("url", OTHER_URLS)
def test_other_endpoints_keep_16_mib(internal_client, url):
    response = post_raw(internal_client, url, b"{" + b" " * (16 * MIB) + b"}")

    assert response.status_code == 413
    assert response.json()["message"] == f"요청 본문은 {16 * MIB}바이트를 넘을 수 없습니다."


def test_compare_over_32_mib_returns_413(internal_client):
    response = post_raw(internal_client, URL, b"{" + b" " * (32 * MIB) + b"}")

    assert response.status_code == 413
    assert response.json() == {"error": "PAYLOAD_TOO_LARGE", "message": f"요청 본문은 {32 * MIB}바이트를 넘을 수 없습니다."}


def test_compare_limit_also_applies_to_chunked_bodies():
    def chunks():
        yield b"{"
        for _ in range(10):
            yield b" " * 1000
        yield b"}"

    with TestClient(create_app(Settings(internal_token=TOKEN, compare_max_body_bytes=4096))) as c:
        response = c.post(URL, content=chunks(), headers={**AUTH, "Content-Type": "application/json"})
        other = c.post(OTHER_URLS[0], content=chunks(), headers={**AUTH, "Content-Type": "application/json"})

    assert "content-length" not in response.request.headers
    assert response.status_code == 413
    assert other.status_code == 422  # within the 16 MiB limit of building-stats: fails validation instead


def test_limits_are_independent():
    with TestClient(create_app(Settings(internal_token=TOKEN, max_body_bytes=2048))) as c:
        compare = post_raw(c, URL, padded(valid_payload(), 64 * 1024))
        stats = post_raw(c, OTHER_URLS[0], b"{" + b" " * 3000 + b"}")

    assert compare.status_code == 200 and stats.status_code == 413


# ----------------------------------------------------------------------------------------- OpenAPI

def test_openapi_documents_compare(client):
    schema = client.get("/openapi.json").json()
    operation = schema["paths"][URL]["post"]
    schemas = schema["components"]["schemas"]
    request = schemas["CompareRequest"]

    assert operation["requestBody"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/CompareRequest"}
    assert operation["responses"]["200"]["content"]["application/json"]["schema"] == {
        "$ref": "#/components/schemas/CompareResponse"}
    assert operation["security"] == [{"InternalToken": []}]
    assert {"401", "413", "415", "422", "503"} <= set(operation["responses"])
    assert set(request["required"]) == {"before", "after"}
    assert request["properties"]["includeUnchanged"]["default"] is False
    assert request["properties"]["includeBuildingChanges"]["default"] is True
    assert {"source", "criterion", "dataSource", "center", "radiusMeters", "buildings"} <= set(
        schemas["SavedAnalysis"]["required"])
    refs = {part.split('"')[0] for part in json.dumps(schema).split('"$ref": "#/components/schemas/')[1:]}
    assert refs <= set(schemas)


def test_existing_endpoints_are_still_documented(client):
    paths = client.get("/openapi.json").json()["paths"]

    assert {"/health", *OTHER_URLS, URL} <= set(paths)
    assert "security" not in paths["/health"]["get"]


# ----------------------------------------------------------------------------------------- end to end

def test_5000_buildings_twice_end_to_end(internal_client):
    data = payload(city(0), city(1), before={"radius": 1000}, after={"radius": 1000})
    body = json.dumps(data).encode()

    started = time.perf_counter()
    response = post_raw(internal_client, URL, body)
    elapsed = time.perf_counter() - started
    print(f"\n5000 x 2 compare end to end: {len(body) / MIB:.2f} MiB request, "
          f"{len(response.content) / 1024:.0f} KiB response, {elapsed:.3f}s")

    assert response.status_code == 200
    summary = response.json()["buildings"]["summary"]
    assert summary["added"] == summary["removed"] == summary["candidates"]
    assert elapsed < 10


def test_large_real_geometry_over_16_mib(internal_client):
    """Two analyses of 5000 buildings with 45-vertex footprints: over 16 MiB of real coordinates."""
    def detailed(count):
        buildings = []
        for i in range(count):
            x, y = -900 + (i % 70) * 26.0, -900 + (i // 70) * 26.0
            points = [(x + 10 + 9 * math.cos(k / 22 * math.pi), y + 10 + 9 * math.sin(k / 22 * math.pi))
                      for k in range(44)]
            buildings.append(building(f"bd:{i:05d}", polygon(ring(points))))
        return buildings

    data = payload(detailed(5000), detailed(5000), before={"radius": 1000}, after={"radius": 1000})
    body = json.dumps(data).encode()
    started = time.perf_counter()
    response = post_raw(internal_client, URL, body)
    elapsed = time.perf_counter() - started
    print(f"\n5000 x 2 compare, 45-vertex footprints: {len(body) / MIB:.2f} MiB request, {elapsed:.3f}s")

    assert 16 * MIB < len(body) <= 32 * MIB
    assert response.status_code == 200
    assert response.json()["buildings"]["summary"]["unchanged"] == response.json()["before"]["counts"]["analyzed"]
    assert elapsed < 20
