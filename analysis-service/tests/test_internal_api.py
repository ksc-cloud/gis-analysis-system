import json
import logging
import time

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from tests.factories import AUTH, TOKEN, building, polygon, rect, request

URL = "/internal/v1/building-stats"


def valid_payload() -> dict:
    return request([building("bd:1", polygon(rect(10, -5, 30, 5)), floors="5")])


def post(client, payload, headers=None):
    return client.post(URL, json=payload, headers=AUTH if headers is None else headers)


# ----------------------------------------------------------------------------------------- auth

def test_valid_request_returns_statistics(internal_client):
    response = post(internal_client, valid_payload())
    body = response.json()

    assert response.status_code == 200
    assert body["schemaVersion"] == 1
    assert body["counts"]["total"] == 1
    assert body["footprint"]["sumArea"] == pytest.approx(200, abs=0.01)
    assert body["method"]["circleSegments"] == 256
    assert body["completeness"]["scope"] == "COMPLETE_RESULT"


def test_token_not_configured_returns_503(client):
    response = post(client, valid_payload())

    assert response.status_code == 503
    assert response.json()["error"] == "INTERNAL_TOKEN_NOT_CONFIGURED"


@pytest.mark.parametrize("headers", [{}, {"X-Internal-Token": ""}, {"X-Internal-Token": "wrong"},
                                     {"X-Internal-Token": TOKEN + "x"}, {"Authorization": f"Bearer {TOKEN}"}])
def test_missing_or_wrong_token_returns_401(internal_client, headers):
    response = post(internal_client, valid_payload(), headers=headers)

    assert response.status_code == 401
    assert response.json() == {"error": "UNAUTHORIZED", "message": "내부 인증 토큰이 없거나 올바르지 않습니다."}


def test_auth_is_checked_before_the_body(internal_client):
    response = internal_client.post(URL, content=b"not json", headers={"Content-Type": "application/json"})

    assert response.status_code == 401


def test_unknown_internal_path_also_requires_token(internal_client):
    assert internal_client.get("/internal/v1/nothing").status_code == 401
    assert internal_client.get("/internal/v1/nothing", headers=AUTH).status_code == 404
    assert internal_client.get(URL, headers=AUTH).status_code == 405


def test_token_never_appears_in_responses_or_logs(internal_client, caplog):
    caplog.set_level(logging.DEBUG)
    responses = [post(internal_client, valid_payload()),
                 post(internal_client, valid_payload(), headers={"X-Internal-Token": "wrong"}),
                 post(internal_client, {"bad": 1})]

    for response in responses:
        assert TOKEN not in response.text
    assert TOKEN not in caplog.text
    assert TOKEN not in repr(Settings(internal_token=TOKEN))


def test_health_is_unchanged_and_needs_no_token(internal_client, client):
    for c in (internal_client, client):
        response = c.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


def test_no_cors_on_internal_api(internal_client):
    response = post(internal_client, valid_payload(), headers={**AUTH, "Origin": "http://localhost:8080"})

    assert "access-control-allow-origin" not in response.headers


# ----------------------------------------------------------------------------------------- size and type

def test_content_type_must_be_json(internal_client):
    response = internal_client.post(URL, content=json.dumps(valid_payload()),
                                    headers={**AUTH, "Content-Type": "text/plain"})

    assert response.status_code == 415
    assert response.json()["error"] == "UNSUPPORTED_MEDIA_TYPE"


def test_declared_body_over_limit_returns_413():
    with TestClient(create_app(Settings(internal_token=TOKEN, max_body_bytes=2048))) as c:
        response = c.post(URL, content=b"{" + b" " * 3000 + b"}", headers={**AUTH, "Content-Type": "application/json"})

    assert response.status_code == 413
    assert response.json()["error"] == "PAYLOAD_TOO_LARGE"


def test_chunked_body_over_limit_returns_413():
    def chunks():
        yield b"{"
        for _ in range(10):
            yield b" " * 1000
        yield b"}"

    with TestClient(create_app(Settings(internal_token=TOKEN, max_body_bytes=2048))) as c:
        response = c.post(URL, content=chunks(), headers={**AUTH, "Content-Type": "application/json"})

    assert "content-length" not in response.request.headers
    assert response.status_code == 413


def test_default_body_limit_is_16_mib():
    assert Settings().max_body_bytes == 16 * 1024 * 1024


# ----------------------------------------------------------------------------------------- validation

def test_invalid_json_returns_400(internal_client):
    response = internal_client.post(URL, content=b"{bad", headers={**AUTH, "Content-Type": "application/json"})

    assert response.status_code == 400
    assert response.json()["error"] == "INVALID_JSON"


def test_nan_is_rejected(internal_client):
    text = json.dumps(valid_payload()).replace('"lat": 37.5}', '"lat": NaN}', 1)
    response = internal_client.post(URL, content=text, headers={**AUTH, "Content-Type": "application/json"})

    assert response.status_code == 422
    assert any(d["type"] == "finite_number" for d in response.json()["details"])


@pytest.mark.parametrize("radius", [49, 1001, 0, -100, "300", 300.5, None])
def test_invalid_radius(internal_client, radius):
    response = post(internal_client, {**valid_payload(), "radiusMeters": radius})

    assert response.status_code == 422
    assert response.json()["details"][0]["loc"] == "body.radiusMeters"


@pytest.mark.parametrize("center", [{"lon": 123.9, "lat": 37.5}, {"lon": 127.0, "lat": 39.1},
                                    {"lon": 127.0}, {"lon": "127", "lat": 37.5}, {"lon": 37.5, "lat": 127.0}])
def test_invalid_center(internal_client, center):
    response = post(internal_client, {**valid_payload(), "center": center})

    assert response.status_code == 422
    assert response.json()["error"] == "VALIDATION_ERROR"


@pytest.mark.parametrize("coordinates", [
    [[[127.0, 37.5], [127.001, 37.5], [127.0, 37.5]]],                          # 3 positions
    [[[127.0, 37.5], [127.001, 37.5], [127.001, 37.501], [127.0, 37.501]]],     # not closed
    [[[127.0, 37.5, 10.0], [127.001, 37.5, 10.0], [127.001, 37.501, 10.0], [127.0, 37.5, 10.0]]],  # 3D
    [[[181.0, 37.5], [127.001, 37.5], [127.001, 37.501], [181.0, 37.5]]],       # longitude out of range
    [],                                                                          # no rings
])
def test_invalid_polygon_structure(internal_client, coordinates):
    payload = valid_payload()
    payload["buildings"][0]["geometry"] = {"type": "Polygon", "coordinates": coordinates}

    assert post(internal_client, payload).status_code == 422


def test_unsupported_geometry_type(internal_client):
    payload = valid_payload()
    payload["buildings"][0]["geometry"] = {"type": "LineString", "coordinates": [[127.0, 37.5], [127.1, 37.5]]}

    assert post(internal_client, payload).status_code == 422


def test_duplicate_building_id_rejects_the_request(internal_client):
    payload = request([building("bd:1", polygon(rect(0, 0, 10, 10))),
                       building("bd:1", polygon(rect(20, 0, 30, 10)))])
    response = post(internal_client, payload)

    assert response.status_code == 422
    assert response.json()["error"] == "DUPLICATE_BUILDING_ID"
    assert "buildings[1]" in response.json()["details"][0]["msg"]


def test_completeness_must_match_reasons(internal_client):
    assert post(internal_client, {**valid_payload(), "complete": False, "incompleteReasons": []}).status_code == 422
    assert post(internal_client, {**valid_payload(), "complete": True,
                                  "incompleteReasons": [{"code": "PAGE_LIMIT", "message": "x"}]}).status_code == 422


def test_unknown_fields_are_rejected(internal_client):
    assert post(internal_client, {**valid_payload(), "radius": 100}).status_code == 422


def test_saved_source_needs_analysis_id(internal_client):
    assert post(internal_client, {**valid_payload(), "source": {"kind": "SAVED"}}).status_code == 422
    response = post(internal_client, {**valid_payload(), "source": {"kind": "SAVED", "analysisId": 7}})
    assert response.status_code == 200
    assert response.json()["source"]["analysisId"] == 7


def test_too_many_buildings(internal_client):
    payload = request([building(f"bd:{i}", polygon(rect(0, 0, 1, 1))) for i in range(5001)])

    response = post(internal_client, payload)
    assert response.status_code == 422
    assert response.json()["details"][0]["type"] == "too_long"


def test_too_many_points(internal_client):
    # 51 rings x 10,000 positions = 510,000 > 500,000, with short numbers to stay below 16 MiB.
    ring = [[127, 37]] * 10_000
    payload = request([building(f"bd:{i}", {"type": "Polygon", "coordinates": [ring]}) for i in range(51)])

    response = post(internal_client, payload)
    assert response.status_code == 422
    assert response.json()["details"][0]["type"] == "too_many_points"


def test_errors_do_not_echo_submitted_geometry(internal_client):
    payload = request([building(f"bd:{i}", polygon(rect(i, 0, i + 1, 1))) for i in range(500)])
    payload["buildings"][499]["geometry"]["coordinates"][0][0][1] = 95.0  # latitude out of range
    response = post(internal_client, payload)

    assert response.status_code == 422
    assert len(response.content) < 2000
    assert "127.0" not in response.text and "input" not in response.json()["details"][0]


def test_validation_details_are_capped(internal_client):
    # 50 buildings x 4 positions with latitude 95: 200 errors.
    payload = request([building(f"bd:{i}", {"type": "Polygon", "coordinates": [[[127, 95]] * 4]}) for i in range(50)])
    body = post(internal_client, payload).json()

    assert len(body["details"]) == 20
    assert "건 중 20건 표시" in body["message"]


# ----------------------------------------------------------------------------------------- end to end

def test_5000_buildings_end_to_end(internal_client):
    buildings = []
    for i in range(5000):
        x = -1050 + (i % 75) * 28.0
        y = -1050 + (i // 75) * 28.0
        buildings.append(building(f"bd:{i:05d}", polygon(rect(x, y, x + 20, y + 15)), floors=str(i % 30)))
    body = json.dumps(request(buildings, radius=1000)).encode()

    started = time.perf_counter()
    response = internal_client.post(URL, content=body, headers={**AUTH, "Content-Type": "application/json"})
    elapsed = time.perf_counter() - started
    print(f"\n5000 buildings end to end: {len(body) / 1024 / 1024:.2f} MiB request, "
          f"{len(response.content) / 1024 / 1024:.2f} MiB response, {elapsed:.3f}s")

    assert response.status_code == 200
    assert response.json()["counts"]["total"] == 5000
    assert elapsed < 10
