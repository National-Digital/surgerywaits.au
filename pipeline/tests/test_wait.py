import pytest

from surgerywaits import NOT_PUBLISHED, format_wait_days


def test_suppressed_cell_is_not_published() -> None:
    assert format_wait_days(None) == NOT_PUBLISHED


@pytest.mark.parametrize(
    ("days", "expected"),
    [(0, "0 days"), (1, "1 day"), (47, "47 days")],
)
def test_number_of_days(days: int, expected: str) -> None:
    assert format_wait_days(days) == expected
