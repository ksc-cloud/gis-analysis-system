"""Contract of POST /internal/v1/hotspot.

The request is the building-stats request (one Java radius analysis result) plus the grid cell size and the
permutation test options. The response returns the grid-density cells (same ids, geometry and order) with the
Getis-Ord Gi* result of each cell, the global Moran's I and the hotspot status.

A partial analysis (complete=false, any reason) or a building whose footprint Python cannot repair
(INVALID_GEOMETRY) is never analyzed: status PARTIAL_RESULT_BLOCKED, no grid, no cells.
"""

from typing import Annotated, Literal

from pydantic import Field, StrictInt, field_validator
from pydantic_core import PydanticCustomError

from app.geo.grid import CELL_SIZES
from app.schemas.building_stats import (SCHEMA_VERSION, Completeness, Counts, RadiusAnalysisRequest, Source,
                                        StatWarning)
from app.schemas.common import Center, ResponseModel
from app.schemas.grid_density import CellPolygon, GridInfo
from app.services.hotspot_stats import (DEFAULT_PERMUTATIONS, DEFAULT_SEED, MIN_TESTED_CELLS,
                                        PERMUTATION_CHOICES, SPARSE_NONZERO_RATIO)

MAX_SEED = 2**31 - 1

Status = Literal["OK", "CONSTANT_VALUES", "INSUFFICIENT_CELLS", "PARTIAL_RESULT_BLOCKED"]
HotspotClass = Literal["HOT_99", "HOT_95", "HOT_90", "NOT_SIGNIFICANT", "COLD_90", "COLD_95", "COLD_99",
                       "NOT_TESTED"]
NotTestedReason = Literal["SMALL_BOUNDARY", "NO_NEIGHBORS", "UNDEFINED_VARIANCE", "CONSTANT_VALUES",
                          "INSUFFICIENT_CELLS"]
NOT_TESTED_REASONS: tuple[str, ...] = NotTestedReason.__args__


class HotspotRequest(RadiusAnalysisRequest):
    """
    cell_size_meters: 50, 100 or 200 (the grid of grid-density, all cells)
    permutations: Moran's I permutation count, 99, 999 or 9999
    seed: random seed of the permutations (same request, same result)
    """

    cell_size_meters: Annotated[StrictInt, Field(json_schema_extra={"enum": list(CELL_SIZES)})]
    permutations: Annotated[StrictInt, Field(json_schema_extra={"enum": list(PERMUTATION_CHOICES)})] = \
        DEFAULT_PERMUTATIONS
    seed: Annotated[StrictInt, Field(ge=0, le=MAX_SEED)] = DEFAULT_SEED

    @field_validator("cell_size_meters")
    @classmethod
    def _allowed_size(cls, value):
        if value not in CELL_SIZES:
            raise PydanticCustomError("cell_size_not_allowed", "cellSizeMeters must be one of 50, 100, 200")
        return value

    @field_validator("permutations")
    @classmethod
    def _allowed_permutations(cls, value):
        if value not in PERMUTATION_CHOICES:
            raise PydanticCustomError("permutations_not_allowed", "permutations must be one of 99, 999, 9999")
        return value


# --------------------------------------------------------------------------------------------- response

class HotspotMethod(ResponseModel):
    statistic: str = "GETIS_ORD_GI_STAR"
    variable: str = "coverageRatio"
    contiguity: str = "QUEEN"
    gi_weights: str = "BINARY_WITH_SELF"
    gi_p_value: str = "NORMAL_TWO_SIDED"
    moran_weights: str = "ROW_STANDARDIZED"
    moran_p_value: str = "PERMUTATION_TWO_SIDED_ABOUT_EXPECTATION"
    correction: str = "BENJAMINI_HOCHBERG"
    levels: list[float] = [0.10, 0.05, 0.01]
    permutations: int
    seed: int
    min_tested_cells: int = MIN_TESTED_CELLS
    sparse_nonzero_ratio: float = SPARSE_NONZERO_RATIO
    small_boundary_policy: str = "EXCLUDED"
    description: str
    limitations: list[str]


class GlobalMoran(ResponseModel):
    """
    i: Moran's I (row-standardized Queen weights); expected: E[I] = -1/(n-1)
    p_value: two-sided permutation p-value about E[I], (#{|I_sim - E| >= |I - E|} + 1) / (P + 1)
    z_simulated: (I - simulated_mean) / simulated_sd, null when the simulations do not vary
    """

    i: float
    expected: float
    p_value: float
    z_simulated: float | None
    simulated_mean: float
    simulated_sd: float


class HotspotSummary(ResponseModel):
    """
    cell_count: grid cells; study_cell_count: cells in the statistics (not small boundary, with a neighbor);
    tested_cell_count: cells with a Gi* (the m of Benjamini-Hochberg)
    classes: cells per hotspot class (every class, 0 when none)
    not_tested_reasons: NOT_TESTED cells per reason (every reason, 0 when none)
    """

    cell_count: int
    study_cell_count: int
    tested_cell_count: int
    classes: dict[str, int]
    not_tested_reasons: dict[str, int]


class HotspotCompleteness(Completeness):
    """
    complete: the hotspot input is complete: the Java analysis is complete (source_complete) and Python excluded
    no building it could not repair (python_geometry_excluded = 0); false whenever the status is
    PARTIAL_RESULT_BLOCKED
    source_complete: RadiusAnalysisResult.complete as sent by Java
    python_geometry_excluded: buildings Python excluded as INVALID_GEOMETRY (null when not computed)
    """

    source_complete: bool
    python_geometry_excluded: int | None


class HotspotCellProperties(ResponseModel):
    """
    The grid-density cell (col, row, center, boundary, small_boundary, domain_ratio, coverage_ratio) and its
    hotspot result. neighbor_count: Queen neighbors among the cells that are not small boundary cells (null for
    those). gi_z, p_value, q_value: Gi* z-score, two-sided normal p, Benjamini-Hochberg q (null unless tested).
    hotspot_class is decided from the unrounded q-value.
    """

    col: int
    row: int
    center_lon: float
    center_lat: float
    boundary: bool
    small_boundary: bool
    domain_ratio: float
    coverage_ratio: float
    neighbor_count: int | None
    gi_z: float | None
    p_value: float | None
    q_value: float | None
    hotspot_class: HotspotClass
    bin: int | None
    reason: NotTestedReason | None


class HotspotCellFeature(ResponseModel):
    type: Literal["Feature"] = "Feature"
    id: str
    geometry: CellPolygon
    properties: HotspotCellProperties


class HotspotCellFeatureCollection(ResponseModel):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[HotspotCellFeature]


class HotspotResponse(ResponseModel):
    """
    status: OK, CONSTANT_VALUES, INSUFFICIENT_CELLS (cells returned, not tested) or PARTIAL_RESULT_BLOCKED
    (grid, counts and moran null, no cells, summary all 0)
    blocked_reasons: why the analysis was blocked (Java incomplete reason codes as sent, and
    PYTHON_GEOMETRY_EXCLUDED); empty otherwise
    """

    schema_version: int = SCHEMA_VERSION
    source: Source | None
    center: Center
    radius_meters: int
    cell_size_meters: int
    status: Status
    blocked_reasons: list[str]
    method: HotspotMethod
    grid: GridInfo | None
    counts: Counts | None
    moran: GlobalMoran | None
    summary: HotspotSummary
    completeness: HotspotCompleteness
    warnings: list[StatWarning]
    cells: HotspotCellFeatureCollection
