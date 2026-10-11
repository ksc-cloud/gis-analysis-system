import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from tests.factories import TOKEN


@pytest.fixture
def client():
    with TestClient(create_app(Settings())) as test_client:
        yield test_client


@pytest.fixture
def internal_client():
    with TestClient(create_app(Settings(internal_token=TOKEN))) as test_client:
        yield test_client
