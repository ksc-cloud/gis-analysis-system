"""Contract of POST /internal/v1/building-stats.

The request reuses the Java radius analysis result (live ``/api/buildings/nearby`` or saved
``/api/analyses/{id}``): the center, radius, completeness and the included buildings with their GeoJSON
footprints and raw ground floor values.
"""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import Field, StrictBool, StrictInt, field_validator, model_validator
from pydantic_core import PydanticCustomError

from app.schemas.common import Center, CamelModel, FiniteFloat, ResponseModel

SCHEMA_VERSION = 1

# Same range as RadiusAnalysisService.MIN_RADIUS / MAX_RADIUS.
MIN_RADIUS, MAX_RADIUS = 50, 1000

# Size limits (a radius analysis keeps at most 5 pages x 1000 features; gis_analysis_building allows 5000 rows).
MAX_BUILDINGS = 5000
MAX_POLYGONS_PER_BUILDING = 100
MAX_RINGS_PER_POLYGON = 100
MAX_POINTS_PER_RING = 10_000
MAX_TOTAL_POINTS = 500_000
MAX_REASONS = 20

Lon = Annotated[FiniteFloat, Field(ge=-180, le=180)]
Lat = Annotated[FiniteFloat, Field(ge=-90, le=90)]
Position = tuple[Lon, Lat]
Ring = Annotated[list[Position], Field(min_length=4, max_length=MAX_POINTS_PER_RING)]
PolygonRings = Annotated[list[Ring], Field(min_length=1, max_length=MAX_RINGS_PER_POLYGON)]


def _check_closed(polygons: list[list[list[tuple[float, float]]]]) -> None:
    for p, rings in enumerate(polygons):
        for r, ring in enumerate(rings):
            if ring[0] != ring[-1]:
                raise PydanticCustomError("ring_not_closed",
                                          "polygon {polygon} ring {ring}: first and last positions must be equal",
                                          {"polygon": p, "ring": r})


class PolygonGeometry(CamelModel):
    type: Literal["Polygon"]
    coordinates: PolygonRings

    @field_validator("coordinates")
    @classmethod
    def _closed(cls, value):
        _check_closed([value])
        return value

    def polygons(self) -> list[list[list[tuple[float, float]]]]:
        return [self.coordinates]


class MultiPolygonGeometry(CamelModel):
    type: Literal["MultiPolygon"]
    coordinates: Annotated[list[PolygonRings], Field(min_length=1, max_length=MAX_POLYGONS_PER_BUILDING)]

    @field_validator("coordinates")
    @classmethod
    def _closed(cls, value):
        _check_closed(value)
        return value

    def polygons(self) -> list[list[list[tuple[float, float]]]]:
        return self.coordinates


Geometry = Annotated[PolygonGeometry | MultiPolygonGeometry, Field(discriminator="type")]


class Source(CamelModel):
    """Where the analysis comes from, echoed back so saved results can be compared later (step 8-4)."""

    kind: Literal["LIVE", "SAVED"]
    analysis_id: Annotated[StrictInt, Field(ge=1)] | None = None
    analyzed_at: datetime | None = None

    @model_validator(mode="after")
    def _saved_needs_id(self):
        if self.kind == "SAVED" and self.analysis_id is None:
            raise PydanticCustomError("saved_without_id", "analysisId is required when kind is SAVED")
        return self


class IncompleteReason(CamelModel):
    code: Annotated[str, Field(pattern=r"^[A-Z][A-Z_]{0,39}$")]
    message: Annotated[str, Field(max_length=300)]


class JavaSummary(CamelModel):
    """RadiusAnalysisResult.Summary, used only to report buildings Python never sees."""

    intersecting: Annotated[StrictInt, Field(ge=0)]
    inside: Annotated[StrictInt, Field(ge=0)]
    partial: Annotated[StrictInt, Field(ge=0)]
    outside_excluded: Annotated[StrictInt, Field(ge=0)]
    geometry_unavailable: Annotated[StrictInt, Field(ge=0)]
    distinct_buildings: Annotated[StrictInt, Field(ge=0)]
    merged_duplicate_features: Annotated[StrictInt, Field(ge=0)]


class BuildingInput(CamelModel):
    """
    id: AnalyzedBuilding.id (bd:<bd_mgt_sn>, feature:<id> or row:<index>), unique in the request
    ground_floor_raw: gro_flo_co exactly as VWorld returned it (BuildingInfo.groundFloorCount / ground_floor_raw)
    relation, distance_meters: the Java decision, optional, only compared with the Python result
    """

    id: Annotated[str, Field(min_length=1, max_length=80)]
    ground_floor_raw: Annotated[str, Field(max_length=20)] | None = None
    relation: Literal["INSIDE", "PARTIAL"] | None = None
    distance_meters: Annotated[FiniteFloat, Field(ge=0)] | None = None
    geometry: Geometry


class BuildingStatsRequest(CamelModel):
    schema_version: Literal[1] = SCHEMA_VERSION
    source: Source | None = None
    center: Center
    radius_meters: Annotated[StrictInt, Field(ge=MIN_RADIUS, le=MAX_RADIUS)]
    complete: StrictBool
    incomplete_reasons: Annotated[list[IncompleteReason], Field(max_length=MAX_REASONS)] = []
    java_summary: JavaSummary | None = None
    include_buildings: StrictBool = True
    buildings: Annotated[list[BuildingInput], Field(max_length=MAX_BUILDINGS)]

    @model_validator(mode="after")
    def _consistent(self):
        # Java: complete == incompleteReasons.isEmpty()
        if self.complete == bool(self.incomplete_reasons):
            raise PydanticCustomError("completeness_mismatch",
                                      "complete must be true exactly when incompleteReasons is empty")
        seen: dict[str, int] = {}
        total_points = 0
        for index, building in enumerate(self.buildings):
            if building.id in seen:
                raise PydanticCustomError("duplicate_building_id",
                                          "buildings[{index}].id duplicates buildings[{first}].id",
                                          {"index": index, "first": seen[building.id]})
            seen[building.id] = index
            total_points += sum(len(ring) for rings in building.geometry.polygons() for ring in rings)
        if total_points > MAX_TOTAL_POINTS:
            raise PydanticCustomError("too_many_points",
                                      "total positions {count} exceed the limit {limit}",
                                      {"count": total_points, "limit": MAX_TOTAL_POINTS})
        return self


# --------------------------------------------------------------------------------------------- response

class Method(ResponseModel):
    projection: str = "LOCAL_TANGENT_PLANE_WGS84"
    projection_description: str
    area_unit: str = "m2"
    tolerance_meters: float
    circle_segments: int
    circle_area: float
    circle_polygon_area: float
    circle_area_error_ratio: float
    circle_missing_area: float
    circle_max_radial_gap_meters: float
    circle_description: str


class Counts(ResponseModel):
    total: int
    valid_geometry: int
    analyzed: int
    repaired: int
    excluded: int
    inside: int
    partial: int
    zero_area_in_radius: int
    multi_part_overlap: int
    duplicate_geometry: int
    relation_mismatch: int
    distance_mismatch: int


class FootprintStats(ResponseModel):
    sum_area: float
    union_area: float
    between_building_overlap_area: float
    internal_overlap_area: float
    average_area: float | None
    median_area: float | None
    min_area: float | None
    max_area: float | None


class WithinRadiusStats(ResponseModel):
    sum_area: float
    union_area: float
    between_building_overlap_area: float
    coverage_ratio: float
    coverage_percent: float


class FloorStats(ResponseModel):
    population: str = "ALL_INPUT_BUILDINGS"
    with_data: int
    without_data: int
    min: int | None
    max: int | None
    average: float | None
    missing_breakdown: dict[str, int]


class Note(ResponseModel):
    targets: list[str]
    message: str


class Completeness(ResponseModel):
    """
    complete: the Java analysis collected every building VWorld reported
    scope: COMPLETE_RESULT or OBSERVED_BUILDINGS_ONLY
    notes: how each group of statistics may be read when the result is partial
    """

    complete: bool
    scope: Literal["COMPLETE_RESULT", "OBSERVED_BUILDINGS_ONLY"]
    reasons: list[IncompleteReason]
    java_outside_excluded: int | None
    java_geometry_unavailable: int | None
    notes: list[Note]


class StatWarning(ResponseModel):
    code: str
    message: str
    count: int | None = None


class ExcludedBuilding(ResponseModel):
    id: str
    reason: str
    message: str


class BuildingResult(ResponseModel):
    id: str
    relation: str
    distance_meters: float
    center_inside: bool
    footprint_area: float
    area_in_radius: float
    internal_overlap_area: float
    floors: int | None
    repaired: bool
    repair_reasons: list[str]


class BuildingStatsResponse(ResponseModel):
    schema_version: int = SCHEMA_VERSION
    source: Source | None
    center: Center
    radius_meters: int
    method: Method
    counts: Counts
    footprint: FootprintStats
    within_radius: WithinRadiusStats
    floors: FloorStats
    completeness: Completeness
    warnings: list[StatWarning]
    excluded: list[ExcludedBuilding]
    buildings: list[BuildingResult] | None
