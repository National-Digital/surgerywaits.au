def name_key(name: str) -> str:
    """One comparison form for hospital names, shared so the register and the reader agree."""
    return " ".join(name.split()).casefold()
