"""Contract of POST /internal/v1/compare-analyses.

``before`` and ``after`` are two saved Java radius analyses (GET /api/analyses/{id}), each in the building-stats
request shape plus the criterion and data source of the result, so the same validation applies to both sides.
"""

from typing import Annotated, Literal

from pydantic import Field, StrictBool, model_validator
from pydantic_core import PydanticCustomError

from app.schemas.building_stats import (SCHEMA_VERSION, Counts, IncompleteReason, Method, Note, RadiusAnalysisRequest,
                                        Source, StatWarning)
from app.schemas.common import CamelModel, Center, ResponseModel


class DataSource(CamelModel):
    """RadiusAnalysisResult.DataSource."""

    provider: Annotated[str, Field(min_length=1, max_length=100)]
    layer: Annotated[str, Field(min_length=1, max_length=100)]
    coordinate_system: Annotated[str, Field(min_length=1, max_length=50)]
    notice: Annotated[str, Field(max_length=300)] | None = None


class SavedAnalysis(RadiusAnalysisRequest):
    """One saved analysis. source must be SAVED with analysisId and a timezone-aware analyzedAt."""

    source: Source
    criterion: Annotated[str, Field(min_length=1, max_length=40)]
    data_source: DataSource

    @model_validator(mode="after")
    def _saved(self):
        if self.source.kind != "SAVED":
            raise PydanticCustomError("saved_analysis_required", "source.kind must be SAVED")
        analyzed_at = self.source.analyzed_at
        if analyzed_at is None or analyzed_at.tzinfo is None:
            raise PydanticCustomError("analyzed_at_required",
                                      "source.analyzedAt is required and must include a time zone (for example Z)")
        return self


class CompareRequest(CamelModel):
    """
    include_unchanged: also list the matched buildings without changes in buildings.changes
    include_building_changes: return the building lists (otherwise only buildings.summary)
    """

    schema_version: Literal[1] = SCHEMA_VERSION
    before: SavedAnalysis
    after: SavedAnalysis
    include_unchanged: StrictBool = False
    include_building_changes: StrictBool = True

    @model_validator(mode="after")
    def _order(self):
        if self.before.source.analysis_id == self.after.source.analysis_id:
            raise PydanticCustomError("same_analysis", "before and after must be different analyses (analysisId)")
        if self.before.source.analyzed_at > self.after.source.analyzed_at:
            raise PydanticCustomError("analysis_order_reversed",
                                      "before.source.analyzedAt must not be later than after.source.analyzedAt")
        return self


# --------------------------------------------------------------------------------------------- response

class Reason(ResponseModel):
    code: str
    message: str


class IdentifierCounts(ResponseModel):
    """Input buildings by identifier kind (bd:, feature:, row:, anything else)."""

    bd: int
    feature: int
    row: int
    other: int


class AnalysisSummary(ResponseModel):
    """One side of the comparison: what was compared, and the Python re-analysis of it."""

    source: Source
    center: Center
    radius_meters: int
    complete: bool
    incomplete_reasons: list[IncompleteReason]
    criterion: str
    data_source: DataSource
    counts: Counts
    identifiers: IdentifierCounts
    warnings: list[StatWarning]


class Conditions(ResponseModel):
    """Comparability checks. center_distance_meters is measured on the tangent plane of before.center."""

    center_distance_meters: float
    center_tolerance_meters: float
    same_center: bool
    same_radius: bool
    same_criterion: bool
    same_data_source: bool
    same_coordinate_system: bool
    analyzed_interval_seconds: float
    both_complete: bool


class Metric(ResponseModel):
    """delta = after - before; change_rate = delta / before (null when before is 0 or a value is missing)."""

    unit: str
    before: int | float | None
    after: int | float | None
    delta: int | float | None
    change_rate: float | None


class RatioMetric(Metric):
    """A ratio (0..1); delta_percent_point = delta x 100."""

    delta_percent_point: float | None


class Statistics(ResponseModel):
    """
    building_count: counts.analyzed (buildings the Python re-analysis kept)
    java_building_count: javaSummary.intersecting, when both sides have it
    union_area / sum_area: withinRadius.unionArea / footprint.sumArea of building-stats
    coverage_ratio: withinRadius.coverageRatio
    average_area: footprint.averageArea
    average_floors / floors_with_data: floors.average (unrounded mean) / floors.withData
    """

    basis: Literal["CHANGE", "OBSERVATION_DIFFERENCE"]
    interpretation: str
    building_count: Metric
    java_building_count: Metric | None
    union_area: Metric
    sum_area: Metric
    coverage_ratio: RatioMetric
    average_area: Metric
    average_floors: Metric
    floors_with_data: Metric


class BuildingState(ResponseModel):
    relation: str
    footprint_area: float
    area_in_radius: float
    floors: int | None
    floors_raw: str | None
    repaired: bool


class Match(ResponseModel):
    """
    basis: BD_MGT_SN (same bd: id) or FEATURE_ID_AND_IOU (same feature: id and footprint IoU >= 0.5)
    confidence: HIGH (bd:), MEDIUM (feature:), LOW (a repaired footprint on either side)
    """

    basis: Literal["BD_MGT_SN", "FEATURE_ID_AND_IOU"]
    confidence: Literal["HIGH", "MEDIUM", "LOW"]
    reasons: list[str]


class FloorChange(ResponseModel):
    before: int | None
    after: int | None
    delta: int | None
    before_raw: str | None
    after_raw: str | None


class BuildingChange(ResponseModel):
    """
    status: UNCHANGED, MODIFIED (matched); ADDED, REMOVED (both analyses complete) or ONLY_IN_AFTER, ONLY_IN_BEFORE
    changes: GEOMETRY, FLOORS, FLOORS_DATA (floors known on one side only), RELATION (INSIDE <-> PARTIAL)
    symmetric_difference_area / iou: of the whole footprints, matched buildings only
    """

    id: str
    status: Literal["UNCHANGED", "MODIFIED", "ADDED", "REMOVED", "ONLY_IN_AFTER", "ONLY_IN_BEFORE"]
    match: Match | None
    changes: list[str]
    before: BuildingState | None
    after: BuildingState | None
    footprint_area: Metric | None
    area_in_radius: Metric | None
    symmetric_difference_area: float | None
    iou: float | None
    floors: FloorChange | None


class UncomparableBuilding(ResponseModel):
    """
    category: UNCOMPARABLE (not compared at all) or LOW_CONFIDENCE (compared, also listed in changes)
    side: BEFORE, AFTER or BOTH
    reason: ROW_IDENTIFIER, UNKNOWN_IDENTIFIER, FEATURE_ID_UNVERIFIED, GEOMETRY_EXCLUDED, OUTSIDE_RADIUS,
            COUNTERPART_EXCLUDED, GEOMETRY_REPAIRED
    """

    id: str
    side: Literal["BEFORE", "AFTER", "BOTH"]
    category: Literal["UNCOMPARABLE", "LOW_CONFIDENCE"]
    reason: str
    message: str
    iou: float | None = None


class Candidate(ResponseModel):
    """A possible same building with a different id. Never used for the status of a building.

    status: CANDIDATE (the only pair >= 0.9 for both buildings) or AMBIGUOUS (one of them has several)
    """

    before_id: str
    after_id: str
    iou: float
    symmetric_difference_area: float
    status: Literal["CANDIDATE", "AMBIGUOUS"]


class BuildingSummary(ResponseModel):
    matched: int
    unchanged: int
    modified: int
    added: int
    removed: int
    only_in_after: int
    only_in_before: int
    uncomparable_before: int
    uncomparable_after: int
    low_confidence: int
    candidates: int
    ambiguous_candidates: int


class BuildingComparison(ResponseModel):
    summary: BuildingSummary
    changes: list[BuildingChange] | None
    uncomparable: list[UncomparableBuilding] | None
    possible_same_building: list[Candidate] | None


class CompareMethod(ResponseModel):
    center_tolerance_meters: float
    feature_iou_threshold: float
    candidate_iou_threshold: float
    geometry_tolerance_m2: float
    matching_description: str
    statistics_description: str
    analysis: Method | None


class CompareResponse(ResponseModel):
    schema_version: int = SCHEMA_VERSION
    comparable: bool
    comparison_basis: Literal["CHANGE", "OBSERVATION_DIFFERENCE"]
    not_comparable_reasons: list[Reason]
    before: AnalysisSummary
    after: AnalysisSummary
    conditions: Conditions
    method: CompareMethod
    statistics: Statistics | None
    buildings: BuildingComparison | None
    warnings: list[StatWarning]
    notes: list[Note]

