from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

#: JSON numbers only (no numeric strings); rejects NaN and ±Infinity (Python's JSON parsers accept them).
FiniteFloat = Annotated[float, Field(strict=True, allow_inf_nan=False)]

# Same bounds as BuildingApiController (MIN_LON..MAX_LON, MIN_LAT..MAX_LAT) and ck_history_center.
MIN_LON, MAX_LON = 124.0, 132.0
MIN_LAT, MAX_LAT = 33.0, 39.0


class CamelModel(BaseModel):
    """JSON uses camelCase like the Java API. Unknown fields are rejected so contract typos fail loudly."""

    model_config = ConfigDict(alias_generator=to_camel, extra="forbid", frozen=True, serialize_by_alias=True)


class ResponseModel(BaseModel):
    """Built in Python by field name, serialized as camelCase."""

    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True, validate_by_alias=True,
                              serialize_by_alias=True)


class Center(CamelModel):
    lon: Annotated[FiniteFloat, Field(ge=MIN_LON, le=MAX_LON)]
    lat: Annotated[FiniteFloat, Field(ge=MIN_LAT, le=MAX_LAT)]


class ErrorDetail(ResponseModel):
    loc: str
    msg: str
    type: str


class ErrorResponse(ResponseModel):
    """Same shape as the Java ApiError (error, message). Never contains the submitted geometry."""

    error: str
    message: str
    details: list[ErrorDetail] | None = None
