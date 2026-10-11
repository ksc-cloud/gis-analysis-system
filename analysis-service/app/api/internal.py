"""Internal analysis API, called only by the Java server (authentication and size limits: app.security).

The endpoints read the raw body and validate it in a worker thread, so FastAPI does not parse it; the request
schemas are added to the OpenAPI document separately (app.api.openapi).
"""

from collections.abc import Callable

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ValidationError

from app.api.errors import from_validation_error
from app.api.openapi import request_body
from app.schemas.building_stats import BuildingStatsRequest, BuildingStatsResponse
from app.schemas.common import ErrorResponse
from app.schemas.grid_density import GridDensityRequest, GridDensityResponse
from app.services.building_stats import compute_building_stats
from app.services.grid_density import compute_grid_density

router = APIRouter(prefix="/internal/v1", tags=["internal"])

_ERRORS = {status: {"model": ErrorResponse} for status in (400, 401, 413, 415, 422, 500, 503)}

#: Request models documented in OpenAPI (see app.api.openapi.install).
REQUEST_MODELS: list[type[BaseModel]] = [BuildingStatsRequest, GridDensityRequest]


@router.post("/building-stats", response_model=BuildingStatsResponse, responses=_ERRORS,
             openapi_extra=request_body(BuildingStatsRequest),
             summary="반경 분석 결과의 건물 공간 통계",
             description="요청 본문은 BuildingStatsRequest(JSON)입니다. X-Internal-Token 헤더가 필요합니다.")
async def building_stats(request: Request) -> BuildingStatsResponse:
    body = await request.body()
    # Parsing up to 16 MiB and the geometry work are CPU bound: keep them off the event loop.
    return await run_in_threadpool(_compute, BuildingStatsRequest, compute_building_stats, body)


@router.post("/grid-density", response_model=GridDensityResponse, responses=_ERRORS,
             openapi_extra=request_body(GridDensityRequest),
             summary="반경 분석 결과의 격자별 건물 밀집도",
             description="요청 본문은 GridDensityRequest(JSON)입니다. X-Internal-Token 헤더가 필요합니다. "
                         "격자는 cells(GeoJSON FeatureCollection, 정사각형 셀)로 반환합니다.")
async def grid_density(request: Request) -> GridDensityResponse:
    body = await request.body()
    return await run_in_threadpool(_compute, GridDensityRequest, compute_grid_density, body)


def _compute[Req: BaseModel, Res](model: type[Req], compute: Callable[[Req], Res], body: bytes) -> Res:
    try:
        payload = model.model_validate_json(body)
    except ValidationError as ex:
        raise from_validation_error(ex) from None
    return compute(payload)
