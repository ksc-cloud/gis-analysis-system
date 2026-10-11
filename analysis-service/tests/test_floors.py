import pytest

from app.services.floors import MissingFloor, java_round, missing_reason, summarize_floors, valid_floors


@pytest.mark.parametrize(("raw", "expected"), [
    ("1", 1), ("12", 12), ("007", 7), ("9999", 9999),
    ("0", None), ("00", None), (None, None), ("", None), (" 3", None), ("3 ", None), ("-1", None),
    ("1.5", None), ("12345", None), ("abc", None),
    ("٣", None),  # Arabic-Indic digit three: Java \d (ASCII) rejects it
])
def test_valid_floors_matches_java_rule(raw, expected):
    assert valid_floors(raw) == expected


def test_missing_reason():
    assert missing_reason(None) == MissingFloor.NULL
    assert missing_reason("0") == MissingFloor.ZERO
    assert missing_reason("abc") == MissingFloor.INVALID
    assert missing_reason("5") is None


def test_java_round_is_half_up():
    assert java_round(2.25, 10) == 2.3  # Python round(2.25, 1) gives 2.2
    assert java_round(0.125, 100) == 0.13
    assert java_round(-0.5, 1) == 0.0  # Math.round(-0.5) == 0


def test_summary_average_uses_half_up():
    summary = summarize_floors(["2", "2", "2", "3", None, "0", "x"])

    assert (summary.with_data, summary.without_data) == (4, 3)
    assert (summary.min, summary.max) == (2, 3)
    assert summary.average == 2.3
    assert summary.missing == {MissingFloor.NULL: 1, MissingFloor.ZERO: 1, MissingFloor.INVALID: 1}


def test_summary_without_data():
    summary = summarize_floors([None, "0"])

    assert summary.with_data == 0 and summary.without_data == 2
    assert summary.min is None and summary.max is None and summary.average is None
