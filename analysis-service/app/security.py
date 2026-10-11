"""Guard for /internal/*: X-Internal-Token check, JSON content type and body size limit.

Runs as plain ASGI middleware so a request is rejected before its body is read or parsed. The token
comes only from ANALYSIS_INTERNAL_TOKEN; without it every internal request gets 503 (fail closed).
The token is never logged or returned.
"""

import hmac

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.api.errors import error_response
from app.config import Settings

INTERNAL_PREFIX = "/internal/"
TOKEN_HEADER = "X-Internal-Token"
_BODY_METHODS = {"POST", "PUT", "PATCH"}


class InternalApiGuard:

    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not scope["path"].startswith(INTERNAL_PREFIX):
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        rejection = self._check_headers(headers, scope["method"])
        if rejection is not None:
            await rejection(scope, receive, send)
            return
        if scope["method"] not in _BODY_METHODS:
            await self.app(scope, receive, send)
            return
        body = await self._read_body(receive)
        if body is None:
            await _too_large(self.settings.max_body_bytes)(scope, receive, send)
            return
        await self.app(scope, _replay(body, receive), send)

    def _check_headers(self, headers: Headers, method: str):
        expected = self.settings.internal_token
        if not expected:
            return error_response(503, "INTERNAL_TOKEN_NOT_CONFIGURED",
                                  "분석 서버에 내부 인증 토큰(ANALYSIS_INTERNAL_TOKEN)이 설정되지 않았습니다.")
        supplied = headers.get(TOKEN_HEADER)
        if not supplied or not hmac.compare_digest(supplied.encode(), expected.encode()):
            return error_response(401, "UNAUTHORIZED", "내부 인증 토큰이 없거나 올바르지 않습니다.")
        if method not in _BODY_METHODS:
            return None
        content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            return error_response(415, "UNSUPPORTED_MEDIA_TYPE", "요청 본문은 application/json이어야 합니다.")
        length = headers.get("content-length")
        if length is not None:
            if not length.isdigit():
                return error_response(400, "INVALID_CONTENT_LENGTH", "Content-Length 값이 올바르지 않습니다.")
            if int(length) > self.settings.max_body_bytes:
                return _too_large(self.settings.max_body_bytes)
        return None

    async def _read_body(self, receive: Receive) -> bytes | None:
        """Whole body, or None as soon as it passes the limit (also covers chunked bodies)."""
        limit = self.settings.max_body_bytes
        chunks: list[bytes] = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                break
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > limit:
                return None
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        return b"".join(chunks)


def _too_large(limit: int):
    return error_response(413, "PAYLOAD_TOO_LARGE", f"요청 본문은 {limit}바이트를 넘을 수 없습니다.")


def _replay(body: bytes, receive: Receive) -> Receive:
    sent = False

    async def replay() -> Message:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await receive()

    return replay
