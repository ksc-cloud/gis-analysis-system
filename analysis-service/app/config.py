"""Runtime settings read from environment variables.

Secrets (such as the future internal API token) are never hard-coded; they come
only from the environment. Defaults keep the server bound to the loopback interface.
"""

import os
from collections.abc import Mapping
from dataclasses import dataclass

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8001
DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024

_TRUE_VALUES = {"1", "true", "yes", "on"}
_FALSE_VALUES = {"0", "false", "no", "off"}


@dataclass(frozen=True)
class Settings:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    docs_enabled: bool = True
    # Required by /internal/* (503 while unset). Never logged or returned.
    internal_token: str | None = None
    # Request body limit for /internal/*.
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if environ is None else environ
        return cls(
            host=env.get("ANALYSIS_HOST", DEFAULT_HOST).strip() or DEFAULT_HOST,
            port=_parse_port(env.get("ANALYSIS_PORT")),
            docs_enabled=_parse_bool("ANALYSIS_DOCS_ENABLED", env.get("ANALYSIS_DOCS_ENABLED"), True),
            internal_token=(env.get("ANALYSIS_INTERNAL_TOKEN") or "").strip() or None,
            max_body_bytes=_parse_body_limit(env.get("ANALYSIS_MAX_BODY_BYTES")),
        )

    def __repr__(self) -> str:
        token = "set" if self.internal_token else None
        return (f"Settings(host={self.host!r}, port={self.port}, "
                f"docs_enabled={self.docs_enabled}, internal_token={token!r}, "
                f"max_body_bytes={self.max_body_bytes})")


def _parse_port(value: str | None) -> int:
    if value is None or not value.strip():
        return DEFAULT_PORT
    try:
        port = int(value.strip())
    except ValueError:
        raise ValueError(f"ANALYSIS_PORT must be an integer: {value!r}") from None
    if not 1 <= port <= 65535:
        raise ValueError(f"ANALYSIS_PORT must be between 1 and 65535: {port}")
    return port


def _parse_body_limit(value: str | None) -> int:
    if value is None or not value.strip():
        return DEFAULT_MAX_BODY_BYTES
    try:
        limit = int(value.strip())
    except ValueError:
        raise ValueError(f"ANALYSIS_MAX_BODY_BYTES must be an integer: {value!r}") from None
    if not 1024 <= limit <= 64 * 1024 * 1024:
        raise ValueError(f"ANALYSIS_MAX_BODY_BYTES must be between 1024 and 67108864: {limit}")
    return limit


def _parse_bool(name: str, value: str | None, default: bool) -> bool:
    if value is None or not value.strip():
        return default
    normalized = value.strip().lower()
    if normalized in _TRUE_VALUES:
        return True
    if normalized in _FALSE_VALUES:
        return False
    raise ValueError(f"{name} must be a boolean (true/false): {value!r}")
