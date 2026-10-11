"""Ground floor rules of the Java radius analysis (RadiusAnalysisService.validFloors / floorStatistics)."""

import math
import re
from dataclasses import dataclass
from enum import StrEnum

# Java "\\d{1,4}" with String.matches: ASCII digits only (Python's \d would also accept other scripts).
_FLOORS = re.compile(r"[0-9]{1,4}")


class MissingFloor(StrEnum):
    NULL = "null"
    ZERO = "zero"
    INVALID = "invalid"


def valid_floors(value: str | None) -> int | None:
    """gro_flo_co is a string; only whole numbers of at least 1 are valid ("0" was seen in real responses)."""
    if value is None or not _FLOORS.fullmatch(value):
        return None
    floors = int(value)
    return floors if floors >= 1 else None


def missing_reason(value: str | None) -> MissingFloor | None:
    if value is None:
        return MissingFloor.NULL
    if _FLOORS.fullmatch(value):
        return MissingFloor.ZERO if int(value) < 1 else None
    return MissingFloor.INVALID


def java_round(value: float, scale: float) -> float:
    """Java ``Math.round(value * scale) / scale`` (half up), not Python's round-half-even."""
    return math.floor(value * scale + 0.5) / scale


@dataclass(frozen=True)
class FloorSummary:
    with_data: int
    without_data: int
    min: int | None
    max: int | None
    average: float | None
    missing: dict[MissingFloor, int]


def summarize_floors(values: list[str | None]) -> FloorSummary:
    floors = [f for f in map(valid_floors, values) if f is not None]
    missing = {reason: 0 for reason in MissingFloor}
    for value in values:
        reason = missing_reason(value)
        if reason is not None:
            missing[reason] += 1
    if not floors:
        return FloorSummary(0, len(values), None, None, None, missing)
    average = java_round(sum(floors) / len(floors), 10)
    return FloorSummary(len(floors), len(values) - len(floors), min(floors), max(floors), average, missing)
