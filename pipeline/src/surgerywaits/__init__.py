NOT_PUBLISHED = "not published"


def format_wait_days(days: int | None) -> str:
    # A suppressed cell arrives as None and never reads as 0 or blank.
    if days is None:
        return NOT_PUBLISHED
    return "1 day" if days == 1 else f"{days} days"
