import argparse
import hashlib
import json
import re
import sys
import tempfile
import urllib.request
from collections.abc import Mapping
from dataclasses import asdict, replace
from datetime import date
from pathlib import Path
from typing import Any, cast

from surgerywaits.manifest import MANIFEST_PATH, Entry, ManifestError, Publisher, load
from surgerywaits.metadata import MetadataError, check_metadata, read_metadata
from surgerywaits.pull import BLOCK, TIMEOUT_SECONDS, USER_AGENT, NoRedirect, Opener, PullError

BASE = "https://publicdata.au"
VERSION_FORM = re.compile(r"\d{4}-\d{2}-\d{2}", re.ASCII)
VERSIONS_PATH = "/api/v1/datasets/{slug}/versions"


class RefreshError(Exception):
    pass


def _urlopen(request: urllib.request.Request) -> Any:  # noqa: ANN401
    return urllib.request.build_opener(NoRedirect).open(request, timeout=TIMEOUT_SECONDS)


def _get(url: str) -> urllib.request.Request:
    # Every address is built from BASE and a slug the manifest schema restricts.
    return urllib.request.Request(url, headers={"User-Agent": USER_AGENT})  # noqa: S310


def _read(url: str, opener: Opener) -> bytes:
    with opener(_get(url)) as resp:
        chunks: list[bytes] = []
        while block := resp.read(BLOCK):
            chunks.append(block)
    return b"".join(chunks)


def newest_version(slug: str, opener: Opener) -> str:
    """The latest dated version the versions endpoint lists for a dataset."""
    raw = _read(BASE + VERSIONS_PATH.format(slug=slug), opener)
    try:
        listing = json.loads(raw)
        listed = cast("list[dict[str, str]]", listing["versions"])
        if not all(VERSION_FORM.fullmatch(v["version"]) for v in listed):
            msg = f"{slug}: a listed version is not a YYYY-MM-DD date"
            raise RefreshError(msg)
        found = {date.fromisoformat(v["version"]): v["version"] for v in listed}
        if listing["dataset"] != slug or not found:
            msg = f"{slug}: the versions listing names another dataset or no version"
            raise RefreshError(msg)
    except (ValueError, KeyError, TypeError) as err:
        msg = f"{slug}: unreadable versions listing: {err!r}"
        raise RefreshError(msg) from err
    return found[max(found)]


def _download(url: str, opener: Opener, dest: Path) -> str:
    digest = hashlib.sha256()
    with opener(_get(url)) as resp, dest.open("wb") as out:
        while block := resp.read(BLOCK):
            digest.update(block)
            out.write(block)
    return digest.hexdigest()


def _text(meta: Mapping[str, Any], key: str) -> str | None:
    value = meta.get(key)
    return value if isinstance(value, str) and value else None


def pin(old: Entry, version: str, opener: Opener, workdir: Path) -> Entry:
    """The entry for a newer version, described by the metadata the file itself carries."""
    url = f"{BASE}/d/{old.slug}/v/{version}/data.parquet"
    path = workdir / f"{old.slug}-{version}.parquet"
    digest = _download(url, opener, path)
    meta = read_metadata(path)
    if (meta.get("dataset"), meta.get("version"), meta.get("url")) != (old.slug, version, url):
        msg = f"{old.slug} {version}: the file's metadata names another dataset, version or address"
        raise RefreshError(msg)
    publisher = cast("dict[str, Any]", meta.get("publisher") or {})
    licence = cast("dict[str, Any]", meta.get("licence") or {})
    fields = {
        "licence": licence.get("id"),
        "attribution": _text(meta, "attribution"),
        "citation": _text(meta, "cite"),
        "title": _text(meta, "title"),
        "publisher name": publisher.get("name"),
        "publisher url": publisher.get("url"),
    }
    absent = sorted(k for k, v in fields.items() if not isinstance(v, str) or not v)
    if absent:
        msg = f"{old.slug} {version}: the file's metadata lacks {', '.join(absent)}"
        raise RefreshError(msg)
    entry = replace(
        old,
        version=version,
        release=_text(meta, "release"),
        as_at=_text(meta, "as_at"),
        licence=cast("str", fields["licence"]),
        attribution=cast("str", fields["attribution"]),
        citation=cast("str", fields["citation"]),
        title=cast("str", fields["title"]),
        publisher=Publisher(
            name=cast("str", fields["publisher name"]), url=cast("str", fields["publisher url"])
        ),
        dataset_url=url.removesuffix("data.parquet"),
        url=url,
        sha256=digest,
    )
    check_metadata((entry,), {entry.slug: path})
    return entry


def render(entries: tuple[Entry, ...]) -> str:
    return (
        json.dumps({"datasets": [asdict(e) for e in entries]}, indent=2, ensure_ascii=False) + "\n"
    )


def write(entries: tuple[Entry, ...], manifest: Path) -> None:
    """Write the manifest only after the new text passes the same checks as the build's load."""
    staged = manifest.with_name(manifest.name + ".new")
    staged.write_text(render(entries), encoding="utf-8")
    try:
        load(staged)
    except ManifestError:
        staged.unlink()
        raise
    staged.replace(manifest)


def refresh(manifest: Path, opener: Opener = _urlopen) -> list[tuple[Entry, Entry]]:
    """Move every pin that has a newer version; return each old and new entry."""
    entries = load(manifest)
    moved: list[tuple[Entry, Entry]] = []
    with tempfile.TemporaryDirectory(prefix="surgerywaits-refresh-") as tmp:
        for old in entries:
            latest = newest_version(old.slug, opener)
            if date.fromisoformat(latest) > date.fromisoformat(old.version):
                moved.append((old, pin(old, latest, opener, Path(tmp))))
    if moved:
        new = {n.slug: n for _, n in moved}
        write(tuple(new.get(e.slug, e) for e in entries), manifest)
    return moved


def summary(moved: list[tuple[Entry, Entry]]) -> str:
    lines = [f"- `{o.slug}`: {o.version} to {n.version}" for o, n in moved]
    return "\n".join(lines) + "\n" if lines else ""


def main(argv: list[str] | None = None, opener: Opener = _urlopen) -> int:
    parser = argparse.ArgumentParser(
        description="Move each pin to its newest publicdata.au version."
    )
    parser.add_argument("--manifest", type=Path, default=MANIFEST_PATH)
    parser.add_argument("--summary", type=Path, help="write the list of moved pins here")
    args = parser.parse_args(argv)
    try:
        moved = refresh(args.manifest, opener)
    except (ManifestError, MetadataError, PullError, RefreshError, OSError) as err:
        sys.stderr.write(f"refresh failed: {err}\n")
        return 1
    text = summary(moved)
    sys.stdout.write(text or "every pin is already the newest version\n")
    if args.summary:
        args.summary.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
