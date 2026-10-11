from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_health_returns_ok(client):
    response = client.get("/health")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {"status": "ok"}


def test_unknown_path_returns_404(client):
    assert client.get("/no-such-path").status_code == 404


def test_health_rejects_post(client):
    assert client.post("/health").status_code == 405


def test_no_cors_headers(client):
    response = client.get("/health", headers={"Origin": "http://localhost:8080"})

    assert "access-control-allow-origin" not in response.headers


def test_docs_enabled_by_default(client):
    assert client.get("/openapi.json").status_code == 200


def test_docs_can_be_disabled():
    with TestClient(create_app(Settings(docs_enabled=False))) as client:
        assert client.get("/docs").status_code == 404
        assert client.get("/openapi.json").status_code == 404
        assert client.get("/health").json() == {"status": "ok"}
