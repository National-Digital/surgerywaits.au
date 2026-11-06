import re
from collections.abc import Collection, Iterable, Mapping, Sequence
from datetime import date
from typing import Any, cast

from surgerywaits.manifest import Entry
from surgerywaits.queensland import FacilityQuarter

ALLOWED_LICENCES = frozenset({"CC-BY-4.0", "CC-BY-3.0-AU"})
# A national table's newest financial year may start this many years before its release year.
MAX_PERIOD_AGE_YEARS = 2
# Quarterly data is published within a quarter of its end; the pinned quarter took about 70 days.
MAX_QLD_LAG_DAYS = 200
CREDIT_KEYS = frozenset(
    {"slug", "version", "release", "as_at", "licence", "attribution", "citation", "url", "sha256"}
)
URL_SAFE = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")
CODE_SAFE = re.compile(r"[A-Za-z0-9]+")
RELEASE_DAY = re.compile(r"(\d{4})(\d{2})(\d{2})\d*")


class GateError(Exception):
    pass


def check_licences(entries: Iterable[Entry]) -> None:
    bad = sorted(e.slug for e in entries if e.licence not in ALLOWED_LICENCES)
    if bad:
        msg = f"licence is not on the allow-list: {', '.join(bad)}"
        raise GateError(msg)


def _check_release(entry: Entry) -> None:
    slug = entry.slug
    if entry.as_at is None or entry.release is None:
        msg = f"{slug}: the manifest gives no release"
        raise GateError(msg)
    released = date.fromisoformat(entry.as_at)
    found = RELEASE_DAY.fullmatch(entry.release)
    if found is None or date(*map(int, found.groups())) != released:
        msg = f"{slug}: release {entry.release} disagrees with as_at {entry.as_at}"
        raise GateError(msg)
    if date.fromisoformat(entry.version) < released:
        msg = f"{slug}: version {entry.version} is older than its release {entry.as_at}"
        raise GateError(msg)


def check_freshness(
    entries: Sequence[Entry],
    newest: Mapping[str, str],
    tables: Collection[str],
    qld: Iterable[FacilityQuarter],
) -> None:
    """Offline freshness: each dataset's own newest period against its release, never the clock."""
    by_slug = {e.slug: e for e in entries}
    if not newest:
        msg = "no table periods to check for freshness"
        raise GateError(msg)
    unchecked = sorted(set(tables) - set(newest))
    if unchecked:
        msg = f"tables with no period to check: {', '.join(unchecked)}"
        raise GateError(msg)
    for entry in entries:
        if entry.release is not None and entry.slug not in tables:
            _check_release(entry)
    for slug, period in sorted(newest.items()):
        entry = by_slug[slug]
        _check_release(entry)
        assert entry.as_at is not None  # noqa: S101
        age = int(entry.as_at[:4]) - int(period[:4])
        if not 0 <= age <= MAX_PERIOD_AGE_YEARS:
            msg = f"{slug}: newest period {period} is {age} years from release {entry.as_at}"
            raise GateError(msg)
    for r in qld:
        lag = (r.release_date - r.quarter.end).days
        if not 0 <= lag <= MAX_QLD_LAG_DAYS:
            when = r.quarter.reference_period
            msg = f"queensland {when}: released {r.release_date}, {lag} days after it ended"
            raise GateError(msg)


def _credited(docs: Mapping[str, tuple[str, dict[str, Any]]]) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    sources: list[Any] = docs["credits.json"][1]["sources"]
    for credit in sources:
        keys = set(cast("dict[str, Any]", credit)) if isinstance(credit, dict) else set[str]()
        if keys != set(CREDIT_KEYS):
            msg = "a credit does not have exactly the credit keys"
            raise GateError(msg)
        found[credit["slug"]] = credit
    return found


def check_credits(entries: Sequence[Entry], credited: Mapping[str, dict[str, Any]]) -> None:
    by_slug = {e.slug: e for e in entries}
    for slug, credit in sorted(credited.items()):
        entry = by_slug.get(slug)
        if entry is None or credit != {k: getattr(entry, k) for k in CREDIT_KEYS}:
            msg = f"credit for {slug} does not match the manifest"
            raise GateError(msg)
        if credit["licence"] not in ALLOWED_LICENCES:
            msg = f"credit for {slug} carries licence {credit['licence']}"
            raise GateError(msg)


def _unique(kind: str, values: Iterable[str]) -> None:
    seen: set[str] = set()
    for v in values:
        if not URL_SAFE.fullmatch(v):
            msg = f"{kind} {v!r} is not URL-safe"
            raise GateError(msg)
        if v in seen:
            msg = f"{kind} {v!r} is used twice"
            raise GateError(msg)
        seen.add(v)


def check_slugs(docs: Mapping[str, tuple[str, dict[str, Any]]]) -> None:
    hospitals = [d["slug"] for _, (k, d) in sorted(docs.items()) if k == "hospital"]
    _unique("hospital slug", hospitals)
    listed = [h["slug"] for h in docs["hospitals.json"][1]["hospitals"]]
    if sorted(listed) != sorted(hospitals):
        msg = "the hospital index and the hospital files list different slugs"
        raise GateError(msg)
    files = [(d["kind"], d["slug"]) for _, (k, d) in sorted(docs.items()) if k == "surgery"]
    indexed = [(s["kind"], s["slug"]) for s in docs["surgeries.json"][1]["surgeries"]]
    # Each kind has its own URL directory, so a slug need only be unique within its kind.
    for kind in ("urgency", "procedure", "specialty"):
        _unique(f"{kind} surgery slug", (s for k, s in indexed if k == kind))
        _unique(f"{kind} surgery file slug", (s for k, s in files if k == kind))
    if sorted(files) != sorted(indexed):
        msg = "the surgery index and the surgery files list different slugs"
        raise GateError(msg)
    suburbs = docs["suburbs.json"][1]["suburbs"]
    _unique("suburb code", (str(s[0]).lower() for s in suburbs))
    networks: dict[str, str] = {}
    for _, (kind, d) in sorted(docs.items()):
        n = d.get("network") if kind == "hospital" else None
        if n is not None and networks.setdefault(n["code"], n["name"]) != n["name"]:
            msg = f"network {n['code']} has two names"
            raise GateError(msg)
    for code in networks:
        if not CODE_SAFE.fullmatch(code):
            msg = f"network code {code!r} is not URL-safe"
            raise GateError(msg)
    _unique("network code", (c.lower() for c in networks))


def check_docs(entries: Sequence[Entry], docs: Mapping[str, tuple[str, dict[str, Any]]]) -> None:
    credited = _credited(docs)
    check_licences(e for e in entries if e.slug in credited)
    check_credits(entries, credited)
    for path, (kind, d) in sorted(docs.items()):
        if kind == "credits":
            continue
        if not isinstance(d.get("sources"), list) or not d["sources"]:
            msg = f"{path} lists no sources"
            raise GateError(msg)
        missing = sorted(set(d["sources"]) - set(credited))
        if missing:
            msg = f"{path} cites sources with no credit: {', '.join(missing)}"
            raise GateError(msg)
    check_slugs(docs)
