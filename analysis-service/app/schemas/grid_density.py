"""Contract of POST /internal/v1/grid-density.

The request is the building-stats request (one Java radius analysis result) plus grid options. The response
repeats the building-stats method, counts, completeness, warnings and excluded buildings, and returns the grid as
a GeoJSON FeatureCollection of square cells (lon/lat, WGS84).
"""

from typing import Annotated, Literal

from pydantic import Field, StrictBool, StrictInt, field_validator
from pydantic_core import PydanticCustomError

from app.geo.grid import CELL_SIZES
from app.schemas.building_stats import (SCHEMA_VERSION, Completeness, Counts, ExcludedBuilding, Method,
                                        RadiusAnalysisRequest, Source, StatWarning)
from app.schemas.common import Center, ResponseModel

#: A boundary cell whose part inside the circle is below this share of the cell is a small boundary cell.
SMALL_BOUNDARY_RATIO = 0.25


class GridDensityRequest(RadiusAnalysisRequest):
    """
    cell_size_meters: 50, 100 or 200
    include_empty_cells: also return cells without buildings
    include_cell_building_ids: list the building ids of every cell (properties.buildingIds)
    """

    cell_size_meters: Annotated[StrictInt, Field(json_schema_extra={"enum": list(CELL_SIZES)})]
    include_empty_cells: StrictBool = True
    include_cell_building_ids: StrictBool = False

    @field_validator("cell_size_meters")
    @classmethod
    def _allowed_size(cls, value):
        if value not in CELL_SIZES:
            raise PydanticCustomError("cell_size_not_allowed", "cellSizeMeters must be one of 50, 100, 200")
        return value


# --------------------------------------------------------------------------------------------- response

class GridInfo(ResponseModel):
    """
    origin: cell (0, 0) is centered on the analysis center
    columns / rows: [min, max] cell positions (col east, row north)
    cell_count: every cell that shares area with the circle; returned_cell_count: cells in ``cells``
    """

    cell_size_meters: int
    cell_area: float
    origin: str = "CELL_CENTERED_AT_ANALYSIS_CENTER"
    columns: tuple[int, int]
    rows: tuple[int, int]
    cell_count: int
    returned_cell_count: int
    empty_cell_count: int
    boundary_cell_count: int
    small_boundary_cell_count: int
    small_boundary_ratio: float = SMALL_BOUNDARY_RATIO
    min_building_area_in_cell: float
    description: str
    comparison_with_building_stats: str


class GridSummary(ResponseModel):
    """Totals over all cells (also the cells left out by includeEmptyCells=false)."""

    domain_area: float
    sum_area: float
    occupied_area: float
    coverage_ratio: float
    coverage_percent: float
    occupied_cell_count: int
    primary_building_count: int
    primary_by_nearest_cell: int


class Consistency(ResponseModel):
    """
    *_calculation_difference: unrounded cell total minus unrounded reference (floating point / geometry error)
    *_display_difference: sum of the rounded cell values shown minus the rounded reference (rounding only)
    """

    within_radius_union_area: float
    occupied_area_calculation_difference: float
    occupied_area_display_difference: float
    occupied_area_matches: bool
    circle_area: float
    domain_area_calculation_difference: float
    domain_area_display_difference: float
    analyzed_buildings: int
    primary_building_total: int
    primary_matches_analyzed: bool
    description: str


class CellProperties(ResponseModel):
    """
    domain_area: cell area inside the true circle, the denominator of coverage_ratio
    boundary: the cell crosses the circle (domain_area < cell_area)
    small_boundary: boundary cell with domain_area below smallBoundaryRatio of the cell
    building_count: buildings with at least minBuildingAreaInCell m² in the cell (a building can be in several)
    primary_building_count: buildings whose largest part inside the circle lies in this cell (each counted once)
    sum_area: sum of the building parts in the cell (overlaps counted repeatedly)
    occupied_area: ground covered by buildings in the cell (overlaps counted once)
    building_ids: ids of the buildings counted in building_count, only with includeCellBuildingIds=true
    """

    col: int
    row: int
    center_lon: float
    center_lat: float
    cell_area: float
    domain_area: float
    domain_ratio: float
    boundary: bool
    small_boundary: bool
    building_count: int
    primary_building_count: int
    sum_area: float
    occupied_area: float
    between_building_overlap_area: float
    coverage_ratio: float
    coverage_percent: float
    building_ids: list[str] | None


class CellPolygon(ResponseModel):
    type: Literal["Polygon"] = "Polygon"
    coordinates: list[list[tuple[float, float]]]


class CellFeature(ResponseModel):
    type: Literal["Feature"] = "Feature"
    id: str
    geometry: CellPolygon
    properties: CellProperties


class CellFeatureCollection(ResponseModel):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[CellFeature]


class GridDensityResponse(ResponseModel):
    schema_version: int = SCHEMA_VERSION
    source: Source | None
    center: Center
    radius_meters: int
    cell_size_meters: int
    method: Method
    grid: GridInfo
    counts: Counts
    summary: GridSummary
    consistency: Consistency
    completeness: Completeness
    warnings: list[StatWarning]
    excluded: list[ExcludedBuilding]
    cells: CellFeatureCollection
