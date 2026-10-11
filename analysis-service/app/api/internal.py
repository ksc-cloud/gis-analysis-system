"""Internal analysis API, called only by the Java server (authentication and size limits: app.security)."""

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import ValidationError

from app.api.errors import from_validation_error
from app.schemas.building_stats import BuildingStatsRequest, BuildingStatsResponse
from app.schemas.common import ErrorResponse
from app.services.building_stats import compute_building_stats

router = APIRouter(prefix="/internal/v1", tags=["internal"])

_ERRORS = {status: {"model": ErrorResponse} for status in (400, 401, 413, 415, 422, 500, 503)}


@router.post("/building-stats", response_model=BuildingStatsResponse, responses=_ERRORS,
             summary="반경 분석 결과의 건물 공간 통계",
             description="요청 본문은 BuildingStatsRequest(JSON)입니다. X-Internal-Token 헤더가 필요합니다.")
async def building_stats(request: Request) -> BuildingStatsResponse:
    body = await request.body()
    # Parsing up to 16 MiB and the geometry work are CPU bound: keep them off the event loop.
    return await run_in_threadpool(_compute, body)


def _compute(body: bytes) -> BuildingStatsResponse:
    try:
        payload = BuildingStatsRequest.model_validate_json(body)
    except ValidationError as ex:
        raise from_validation_error(ex) from None
    return compute_building_stats(payload)
