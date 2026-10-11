"""Error responses shaped like the Java ApiError ({error, message}). Submitted values are never echoed."""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.schemas.common import ErrorDetail, ErrorResponse

logger = logging.getLogger(__name__)

MAX_DETAILS = 20


class ApiError(Exception):

    def __init__(self, status: int, error: str, message: str, details: list[ErrorDetail] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.error = error
        self.message = message
        self.details = details


def error_response(status: int, error: str, message: str,
                   details: list[ErrorDetail] | None = None) -> JSONResponse:
    body = ErrorResponse(error=error, message=message, details=details)
    return JSONResponse(status_code=status, content=body.model_dump(exclude_none=True))


def validation_details(errors: list[dict]) -> list[ErrorDetail]:
    """Location, message and type only: the 'input' and 'ctx' members could contain megabytes of geometry."""
    return [ErrorDetail(loc=".".join(str(part) for part in ("body", *error.get("loc", ()))),
                        msg=str(error.get("msg", "")), type=str(error.get("type", "")))
            for error in errors[:MAX_DETAILS]]


def from_validation_error(ex: ValidationError) -> ApiError:
    errors = ex.errors(include_url=False, include_context=False, include_input=False)
    types = {error.get("type") for error in errors}
    details = validation_details(errors)
    suffix = f" (오류 {len(errors)}건 중 {len(details)}건 표시)" if len(errors) > len(details) else ""
    if "json_invalid" in types:
        return ApiError(400, "INVALID_JSON", "요청 본문이 올바른 JSON이 아닙니다." + suffix, details)
    if "duplicate_building_id" in types:
        return ApiError(422, "DUPLICATE_BUILDING_ID", "같은 건물 id가 두 번 이상 있습니다." + suffix, details)
    return ApiError(422, "VALIDATION_ERROR", "요청 값이 계약과 맞지 않습니다." + suffix, details)


def install(app: FastAPI) -> None:

    @app.exception_handler(ApiError)
    async def _api_error(request: Request, ex: ApiError):
        return error_response(ex.status, ex.error, ex.message, ex.details)

    @app.exception_handler(RequestValidationError)
    async def _request_validation(request: Request, ex: RequestValidationError):
        details = validation_details(list(ex.errors()))
        return error_response(422, "VALIDATION_ERROR", "요청 값이 계약과 맞지 않습니다.", details)

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, ex: Exception):
        # The traceback goes to the log only; request bodies and headers are never logged.
        logger.exception("unexpected error: %s %s", request.method, request.url.path)
        return error_response(500, "INTERNAL_ERROR", "분석 서버 내부 오류가 발생했습니다.")
