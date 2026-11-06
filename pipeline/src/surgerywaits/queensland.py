from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from enum import StrEnum
from pathlib import Path

from surgerywaits.hospitals import Hospital, Register, read_rows
from surgerywaits.names import name_key
from surgerywaits.suppression import Figure, qld_figures
from surgerywaits.waiting_times import Row

QLD = "Qld"
ALL = "ALL"
CATEGORIES = ("1", "2", "3")
# The release lists the state-wide total beside the hospitals under this facility code.
STATE_TOTAL_CODE = "99999"
STATE_TOTAL_REASON = "the state-wide total of every reporting hospital, not a place of treatment"

# The release's month label names the last month of the quarter.
QUARTER_END_MONTHS = {"Mar": 1, "Jun": 2, "Sep": 3, "Dec": 4}
MONTH_NAMES = {1: "January", 2: "April", 3: "July", 4: "October"}
END_MONTH_NAMES = {1: "March", 2: "June", 3: "September", 4: "December"}
QUARTER_END_DAY = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}

# National registers write these names in full where Queensland Health shortens them.
NAME_FORMS = (
    "{}",
    "{} hospital",
    "the {} hospital",
    "{} base hospital",
    "{} general hospital",
    "{} university hospital",
)


class QueenslandError(Exception):
    pass


class MatchedBy(StrEnum):
    NAME = "name"
    OVERRIDE = "override"


@dataclass(frozen=True)
class Override:
    facility_name: str
    hospital_code: str
    hospital_name: str


# Only facilities whose name no rule reaches, or reaches ambiguously, are listed. Each names both
# sides as published, so a rename on either side stops the build until a person has looked.
OVERRIDES: Mapping[str, Override] = {
    # The register writes the full name of the Jubilee hospital.
    "22": Override("Queen Elizabeth II", "H0394", "Queen Elizabeth II Jubilee Hospital"),
    # The release abbreviates and misspells "Rehabilitation".
    "33": Override(
        "Surgical Treatment and Rehabltn Service",
        "H1048",
        "Surgical Treatment and Rehabilitation Service",
    ),
    # The register adds the state to tell it from St George in New South Wales.
    "120": Override("St George", "H0450", "St George Hospital Qld"),
    # "Townsville" is also an alias of the Kirwan Rehabilitation Unit.
    "200": Override("Townsville", "H0489", "Townsville University Hospital"),
}


@dataclass(frozen=True)
class FacilityMatch:
    facility_code: str
    facility_name: str
    hospital_code: str
    matched_by: MatchedBy


@dataclass(frozen=True)
class UnmappedFacility:
    facility_code: str
    facility_name: str
    reason: str


@dataclass(frozen=True)
class FacilityMap:
    matches: tuple[FacilityMatch, ...]
    unmapped: tuple[UnmappedFacility, ...]
    not_facilities: tuple[UnmappedFacility, ...]


@dataclass(frozen=True)
class Specialty:
    code: str
    source_name: str
    name: str
    slug: str


# No specialty is paired with a national one, because the two collections count differently.
SPECIALTIES = (
    Specialty("1", "cardio-thoracic surgery", "Cardio-thoracic surgery", "cardio-thoracic"),
    Specialty("2", "ENT surgery", "Ear, nose and throat surgery", "ear-nose-and-throat"),
    Specialty("3", "general surgery", "General surgery", "general"),
    Specialty("4", "gynaecology", "Gynaecology", "gynaecology"),
    Specialty("5", "neurosurgery", "Neurosurgery", "neurosurgery"),
    Specialty("6", "ophthalmology", "Ophthalmology", "ophthalmology"),
    Specialty("7", "orthopaedic surgery", "Orthopaedic surgery", "orthopaedic"),
    Specialty(
        "8", "plastic & reconstructive surgery", "Plastic and reconstructive surgery", "plastic"
    ),
    Specialty("9", "urology", "Urology", "urology"),
    Specialty("10", "vascular surgery", "Vascular surgery", "vascular"),
    Specialty("11", "other surgery", "Other surgery", "other"),
)


@dataclass(frozen=True, order=True)
class Quarter:
    year: int
    quarter: int

    @property
    def end(self) -> date:
        month, day = QUARTER_END_DAY[self.quarter]
        return date(self.year, month, day)

    @property
    def reference_period(self) -> str:
        return f"{MONTH_NAMES[self.quarter]} to {END_MONTH_NAMES[self.quarter]} {self.year}"


@dataclass(frozen=True)
class CategoryFigures:
    category: str
    figures: tuple[Figure, ...]


@dataclass(frozen=True)
class SpecialtyFigures:
    specialty: Specialty
    figures: tuple[Figure, ...]


@dataclass(frozen=True)
class FacilityQuarter:
    hospital_code: str
    facility_code: str
    facility_name: str
    quarter: Quarter
    release_date: date
    total: tuple[Figure, ...]
    categories: tuple[CategoryFigures, ...]
    specialties: tuple[SpecialtyFigures, ...]


@dataclass(frozen=True)
class Overlay:
    facilities: FacilityMap
    specialties: tuple[Specialty, ...]
    quarters: tuple[Quarter, ...]
    records: tuple[FacilityQuarter, ...]


def _text(row: Row, key: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value.strip():
        msg = f"queensland row {row.get('facility_code')}: {key} is missing"
        raise QueenslandError(msg)
    return value


def parse_quarter(label: str) -> Quarter:
    month, _, year = label.partition("-")
    if month not in QUARTER_END_MONTHS or not (len(year) == 2 and year.isdigit()):  # noqa: PLR2004
        msg = f"report month {label!r} is not the last month of a quarter, as in Sep-25"
        raise QueenslandError(msg)
    return Quarter(2000 + int(year), QUARTER_END_MONTHS[month])


def _release_date(row: Row) -> date:
    value = row.get("data_last_update")
    if not isinstance(value, date):
        msg = f"queensland row {row.get('facility_code')}: data_last_update is not a date"
        raise QueenslandError(msg)
    return value


def _facility_names(*tables: Sequence[Row]) -> dict[str, str]:
    names: dict[str, str] = {}
    for table in tables:
        for row in table:
            code, name = _text(row, "facility_code"), _text(row, "facility")
            if names.setdefault(code, name) != name:
                msg = f"facility {code} is published as both {names[code]!r} and {name!r}"
                raise QueenslandError(msg)
    return names


def _by_name(name: str, hospitals: Sequence[Hospital]) -> list[Hospital]:
    forms = {name_key(form.format(name)) for form in NAME_FORMS}
    return [
        h
        for h in hospitals
        if forms & {name_key(h.name), *(name_key(a) for a in h.alternative_names)}
    ]


def _decide(
    code: str,
    name: str,
    queensland: Sequence[Hospital],
    override: Override | None,
) -> tuple[Hospital, MatchedBy] | str:
    """The hospital a facility is, or the reason it is left out."""
    if override is not None:
        hospital = next((h for h in queensland if h.code == override.hospital_code), None)
        if (
            override.facility_name != name
            or hospital is None
            or hospital.name != override.hospital_name
        ):
            msg = f"the override for facility {code} no longer matches the sources"
            raise QueenslandError(msg)
        return hospital, MatchedBy.OVERRIDE
    candidates = _by_name(name, queensland)
    if not candidates:
        return "no public hospital in the national register carries this name"
    if len(candidates) > 1:
        listed = ", ".join(sorted(h.code for h in candidates))
        return f"more than one national hospital carries this name: {listed}"
    return candidates[0], MatchedBy.NAME


def map_facilities(
    names: Mapping[str, str],
    hospitals: Sequence[Hospital],
    overrides: Mapping[str, Override] = OVERRIDES,
) -> FacilityMap:
    """Match each facility to one Queensland hospital, or leave it out with the reason."""
    queensland = [h for h in hospitals if h.state == QLD]
    decided = {
        code: _decide(code, name, queensland, overrides.get(code))
        for code, name in sorted(names.items())
        if code != STATE_TOTAL_CODE
    }
    claimed: dict[str, list[str]] = defaultdict(list)
    for code, outcome in decided.items():
        if not isinstance(outcome, str):
            claimed[outcome[0].code].append(code)
    found: dict[str, tuple[Hospital, MatchedBy]] = {}
    unmapped: dict[str, str] = {}
    for code, outcome in decided.items():
        if isinstance(outcome, str):
            unmapped[code] = outcome
        elif len(claimed[outcome[0].code]) > 1:
            unmapped[code] = f"another facility maps to the same hospital {outcome[0].code}"
        elif outcome[0].closed:
            unmapped[code] = f"the national register lists {outcome[0].code} as closed"
        else:
            found[code] = outcome
    return FacilityMap(
        tuple(FacilityMatch(c, names[c], h.code, how) for c, (h, how) in found.items()),
        tuple(UnmappedFacility(c, names[c], why) for c, why in unmapped.items()),
        tuple(
            UnmappedFacility(c, n, STATE_TOTAL_REASON)
            for c, n in names.items()
            if c == STATE_TOTAL_CODE
        ),
    )


def map_specialties(rows: Sequence[Row]) -> tuple[Specialty, ...]:
    """The mapped specialties the release publishes; any code or name not in the map fails."""
    published: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        code = _text(row, "specialty_code")
        if code != ALL:
            published[code].add(_text(row, "specialty_desc"))
    known = {s.code: s for s in SPECIALTIES}
    problems = [
        f"specialty {code}: {sorted(descs)}"
        for code, descs in sorted(published.items())
        if code not in known or descs != {known[code].source_name}
    ]
    if problems:
        msg = "the specialty map does not cover the release: " + "; ".join(problems)
        raise QueenslandError(msg)
    return tuple(s for s in SPECIALTIES if s.code in published)


def _index(rows: Sequence[Row], key: str) -> dict[tuple[str, Quarter, str], Row]:
    found: dict[tuple[str, Quarter, str], Row] = {}
    for row in rows:
        at = (
            _text(row, "facility_code"),
            parse_quarter(_text(row, "report_month")),
            _text(row, key),
        )
        if at in found:
            msg = f"facility {at[0]} {at[1].reference_period}: {at[2]!r} appears twice"
            raise QueenslandError(msg)
        found[at] = row
    return found


def build_overlay(
    category_rows: Sequence[Row],
    specialty_rows: Sequence[Row],
    hospitals: Sequence[Hospital],
    overrides: Mapping[str, Override] = OVERRIDES,
) -> Overlay:
    facilities = map_facilities(
        _facility_names(category_rows, specialty_rows), hospitals, overrides
    )
    specialties = map_specialties(specialty_rows)
    by_category = _index(category_rows, "category")
    by_specialty = _index(specialty_rows, "specialty_code")
    bad = sorted({k[2] for k in by_category} - {*CATEGORIES, ALL})
    if bad:
        msg = f"unknown urgency categories {bad}"
        raise QueenslandError(msg)
    records: list[FacilityQuarter] = []
    for match in facilities.matches:
        quarters = sorted({q for (f, q, _) in by_category if f == match.facility_code})
        for quarter in quarters:
            where = f"facility {match.facility_code} {quarter.reference_period}"
            total_rows = [
                by_category.get((match.facility_code, quarter, ALL)),
                by_specialty.get((match.facility_code, quarter, ALL)),
            ]
            if any(r is None for r in total_rows):
                msg = f"{where}: a total row is missing from one of the two tables"
                raise QueenslandError(msg)
            total, other = (qld_figures(r) for r in total_rows if r is not None)
            if total != other:
                msg = f"{where}: the two tables disagree on the facility total"
                raise QueenslandError(msg)
            categories = tuple(
                CategoryFigures(c, qld_figures(row))
                for c in CATEGORIES
                if (row := by_category.get((match.facility_code, quarter, c))) is not None
            )
            facility_specialties = tuple(
                SpecialtyFigures(s, qld_figures(row))
                for s in specialties
                if (row := by_specialty.get((match.facility_code, quarter, s.code))) is not None
            )
            used = [r for r in total_rows if r is not None]
            used += [by_category[(match.facility_code, quarter, c.category)] for c in categories]
            used += [
                by_specialty[(match.facility_code, quarter, f.specialty.code)]
                for f in facility_specialties
            ]
            dates = {_release_date(r) for r in used}
            if len(dates) != 1:
                msg = f"{where}: rows carry {len(dates)} release dates"
                raise QueenslandError(msg)
            records.append(
                FacilityQuarter(
                    match.hospital_code,
                    match.facility_code,
                    match.facility_name,
                    quarter,
                    dates.pop(),
                    total,
                    categories,
                    facility_specialties,
                )
            )
    records.sort(key=lambda r: (r.hospital_code, r.quarter))
    return Overlay(
        facilities,
        specialties,
        tuple(sorted({r.quarter for r in records})),
        tuple(records),
    )


def load_overlay(by_category: Path, by_specialty: Path, register: Register) -> Overlay:
    return build_overlay(read_rows(by_category), read_rows(by_specialty), register.hospitals)
