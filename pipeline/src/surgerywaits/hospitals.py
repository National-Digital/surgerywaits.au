from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from typing import Any, Literal, cast

from surgerywaits.names import name_key

# pyarrow ships no type stubs, so it is loaded dynamically and read only through read_rows.
PQ: Any = import_module("pyarrow.parquet")

Row = Mapping[str, object]

# Covers the mainland, Tasmania and the external territories, and still catches a swapped or
# sign-flipped pair.
LATITUDE_RANGE = (-55.0, -9.0)
LONGITUDE_RANGE = (96.0, 168.0)

HOSPITAL_TYPE = "H"
HOSPITAL_RECORD_TYPE = "Hospital"
STATE_MAP = "STATE_MAPPING"
NETWORK_MAP = "H_LHN"
NO_NETWORK = "Not applicable"
ALTERNATIVE_SEPARATOR = "|"

# The publisher's mapping code for each state, and its full name in the hospitals dataset.
STATES = {
    "NSW": "New South Wales",
    "Vic": "Victoria",
    "Qld": "Queensland",
    "WA": "Western Australia",
    "SA": "South Australia",
    "Tas": "Tasmania",
    "ACT": "Australian Capital Territory",
    "NT": "Northern Territory",
}
SECTORS = {"Public": False, "Private": True}
OPEN_CLOSED = {"Open": False, "Closed": True}


NetworkStatus = Literal["mapped", "not_applicable", "unmapped"]


class HospitalError(Exception):
    pass


@dataclass(frozen=True)
class Hospital:
    code: str
    name: str
    alternative_names: tuple[str, ...]
    state: str
    latitude: float | None
    longitude: float | None
    closed: bool
    network_code: str | None
    network_name: str | None
    # "unmapped" means the publisher gave no network; "not_applicable" is its explicit answer.
    network_status: NetworkStatus


@dataclass(frozen=True)
class SharedAlias:
    state: str
    alias: str
    codes: tuple[str, ...]


@dataclass(frozen=True)
class Register:
    hospitals: tuple[Hospital, ...]
    shared_aliases: tuple[SharedAlias, ...]
    excluded_private: tuple[str, ...]


def read_rows(path: Path) -> list[Row]:
    try:
        table: Any = PQ.read_table(path)
    except OSError as err:
        msg = f"cannot read {path.name}: {err}"
        raise HospitalError(msg) from err
    return cast("list[Row]", table.to_pylist())


def _text(row: Row, key: str, where: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value.strip():
        msg = f"{where}: {key} is missing"
        raise HospitalError(msg)
    return value


def _optional_text(row: Row, key: str, where: str) -> str | None:
    value = row.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        msg = f"{where}: {key} is not text"
        raise HospitalError(msg)
    return value or None


def _flag(row: Row, key: str, where: str) -> bool:
    value = row.get(key)
    if not isinstance(value, bool):
        msg = f"{where}: {key} is not true or false"
        raise HospitalError(msg)
    return value


def _choice[T](row: Row, key: str, allowed: Mapping[str, T], where: str) -> T:
    value = _text(row, key, where)
    if value not in allowed:
        msg = f"{where}: unknown {key} {value!r}"
        raise HospitalError(msg)
    return allowed[value]


def _coordinate(row: Row, key: str, bounds: tuple[float, float], where: str) -> float | None:
    value = row.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        msg = f"{where}: {key} is not a number"
        raise HospitalError(msg)
    if not bounds[0] <= value <= bounds[1]:
        msg = f"{where}: {key} {value} is outside Australia"
        raise HospitalError(msg)
    return float(value)


def _by_code(rows: Sequence[Row], key: str, dataset: str) -> dict[str, Row]:
    found: dict[str, Row] = {}
    for row in rows:
        code = _text(row, key, dataset)
        if code in found:
            msg = f"{dataset}: duplicate code {code}"
            raise HospitalError(msg)
        found[code] = row
    return found


def _mappings(
    rows: Sequence[Row], units: Mapping[str, Row], hospital_codes: set[str]
) -> dict[str, dict[str, tuple[str, str]]]:
    found: dict[str, dict[str, tuple[str, str]]] = {}
    for row in rows:
        code = _text(row, "reporting_unit_code", "mappings")
        if code not in units:
            msg = f"mappings: {code} points to a unit that is not in the reporting units"
            raise HospitalError(msg)
        if code not in hospital_codes:
            continue
        kind = _text(row, "map_type_code", f"mappings {code}")
        if kind not in (STATE_MAP, NETWORK_MAP):
            continue
        if kind in found.setdefault(code, {}):
            msg = f"mappings: {code} has more than one {kind} mapping"
            raise HospitalError(msg)
        found[code][kind] = (
            _text(row, "mapped_code", f"mappings {code}"),
            _text(row, "mapped_name", f"mappings {code}"),
        )
    return found


def _network(
    mapped: tuple[str, str] | None, record: Row, where: str
) -> tuple[str | None, str | None, NetworkStatus]:
    name = _optional_text(record, "local_hospital_network", where)
    mapped_name = mapped[1] if mapped else None
    if name != mapped_name:
        msg = f"{where}: network disagrees between the mappings and the hospitals dataset"
        raise HospitalError(msg)
    if mapped is None:
        return None, None, "unmapped"
    if mapped[1] == NO_NETWORK:
        return None, None, "not_applicable"
    return mapped[0], mapped[1], "mapped"


def _check_alternative_names(hospitals: Sequence[Hospital]) -> tuple[SharedAlias, ...]:
    names: dict[tuple[str, str], str] = {}
    for h in hospitals:
        names.setdefault((h.state, name_key(h.name)), h.code)
    users: dict[tuple[str, str], tuple[str, set[str]]] = {}
    for h in hospitals:
        for alt in h.alternative_names:
            key = (h.state, name_key(alt))
            owner = names.get(key)
            if owner is not None and owner != h.code:
                msg = f"{h.code}: alternative name {alt!r} is the name of {owner} in {h.state}"
                raise HospitalError(msg)
            users.setdefault(key, (alt, set()))[1].add(h.code)
    return tuple(
        SharedAlias(state, alias, tuple(sorted(codes)))
        for (state, _), (alias, codes) in sorted(users.items())
        if len(codes) > 1
    )


def build_register(
    units: Sequence[Row], mappings: Sequence[Row], records: Sequence[Row]
) -> Register:
    unit_rows = _by_code(units, "code", "reporting units")
    hospital_units = {c: r for c, r in unit_rows.items() if r.get("type_code") == HOSPITAL_TYPE}
    mapping_rows = _mappings(mappings, unit_rows, set(hospital_units))
    record_rows = _by_code(
        [r for r in records if r.get("type") == HOSPITAL_RECORD_TYPE], "code", "hospitals"
    )
    if set(record_rows) != set(hospital_units):
        gap = sorted(set(record_rows) ^ set(hospital_units))
        msg = f"hospitals and reporting units do not name the same hospitals: {', '.join(gap)}"
        raise HospitalError(msg)

    hospitals: list[Hospital] = []
    private: list[str] = []
    for code in sorted(hospital_units):
        unit, record = hospital_units[code], record_rows[code]
        where = f"hospital {code}"
        is_private = _flag(unit, "private", where)
        if is_private != _choice(record, "sector", SECTORS, where):
            msg = f"{where}: sector disagrees between the reporting units and the hospitals"
            raise HospitalError(msg)
        closed = _flag(unit, "closed", where)
        if closed != _choice(record, "open_closed", OPEN_CLOSED, where):
            msg = f"{where}: closed flag disagrees between the reporting units and the hospitals"
            raise HospitalError(msg)
        mapped = mapping_rows.get(code, {})
        if STATE_MAP not in mapped:
            msg = f"{where}: no state mapping"
            raise HospitalError(msg)
        state = mapped[STATE_MAP][0]
        if state not in STATES:
            msg = f"{where}: unknown state {state!r}"
            raise HospitalError(msg)
        if _text(record, "state", where) != STATES[state]:
            msg = f"{where}: state disagrees between the mappings and the hospitals dataset"
            raise HospitalError(msg)
        latitude = _coordinate(record, "latitude", LATITUDE_RANGE, where)
        longitude = _coordinate(record, "longitude", LONGITUDE_RANGE, where)
        if (latitude is None) != (longitude is None):
            msg = f"{where}: only one of latitude and longitude is given"
            raise HospitalError(msg)
        if is_private:
            private.append(code)
            continue
        network_code, network_name, status = _network(mapped.get(NETWORK_MAP), record, where)
        alternatives = _optional_text(unit, "alternative_names", where) or ""
        hospitals.append(
            Hospital(
                code=code,
                name=_text(unit, "name", where),
                alternative_names=tuple(
                    sorted({a.strip() for a in alternatives.split(ALTERNATIVE_SEPARATOR)} - {""})
                ),
                state=state,
                latitude=latitude,
                longitude=longitude,
                closed=closed,
                network_code=network_code,
                network_name=network_name,
                network_status=status,
            )
        )
    shared = _check_alternative_names(hospitals)
    return Register(tuple(hospitals), shared, tuple(private))


def load_register(units: Path, mappings: Path, records: Path) -> Register:
    return build_register(read_rows(units), read_rows(mappings), read_rows(records))
