import pytest

from app.config import Settings


def test_defaults_bind_loopback_8001():
    settings = Settings.from_env({})

    assert settings.host == "127.0.0.1"
    assert settings.port == 8001
    assert settings.docs_enabled is True
    assert settings.internal_token is None


def test_environment_overrides():
    settings = Settings.from_env({
        "ANALYSIS_HOST": "127.0.0.2",
        "ANALYSIS_PORT": "9001",
        "ANALYSIS_DOCS_ENABLED": "false",
        "ANALYSIS_INTERNAL_TOKEN": "dummy-token",
    })

    assert settings.host == "127.0.0.2"
    assert settings.port == 9001
    assert settings.docs_enabled is False
    assert settings.internal_token == "dummy-token"


def test_blank_values_fall_back_to_defaults():
    settings = Settings.from_env({
        "ANALYSIS_HOST": " ",
        "ANALYSIS_PORT": "",
        "ANALYSIS_DOCS_ENABLED": "",
        "ANALYSIS_INTERNAL_TOKEN": "  ",
    })

    assert settings == Settings()


@pytest.mark.parametrize("port", ["abc", "0", "65536"])
def test_invalid_port_is_rejected(port):
    with pytest.raises(ValueError, match="ANALYSIS_PORT"):
        Settings.from_env({"ANALYSIS_PORT": port})


def test_invalid_bool_is_rejected():
    with pytest.raises(ValueError, match="ANALYSIS_DOCS_ENABLED"):
        Settings.from_env({"ANALYSIS_DOCS_ENABLED": "maybe"})


def test_repr_hides_token():
    settings = Settings.from_env({"ANALYSIS_INTERNAL_TOKEN": "secret-value"})

    assert "secret-value" not in repr(settings)


def test_body_limit_default_and_override():
    assert Settings.from_env({}).max_body_bytes == 16 * 1024 * 1024
    assert Settings.from_env({"ANALYSIS_MAX_BODY_BYTES": "2048"}).max_body_bytes == 2048


@pytest.mark.parametrize("value", ["abc", "100", str(64 * 1024 * 1024 + 1)])
def test_invalid_body_limit_is_rejected(value):
    with pytest.raises(ValueError, match="ANALYSIS_MAX_BODY_BYTES"):
        Settings.from_env({"ANALYSIS_MAX_BODY_BYTES": value})
