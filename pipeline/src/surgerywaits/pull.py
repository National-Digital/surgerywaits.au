import argparse
import hashlib
import http.client
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Protocol, Self

from surgerywaits.manifest import MANIFEST_PATH, URL_FORM, Entry, ManifestError, load

CACHE_DIR = Path(__file__).resolve().parents[2] / ".downloads"
USER_AGENT = "surgerywaits.au-pipeline"
DEADLINE_SECONDS = 600.0
RETRYABLE_CLIENT_ERRORS = frozenset({408, 429})
ATTEMPTS = 5
BACKOFF_SECONDS = 1.0
BACKOFF_CAP_SECONDS = 30.0
TIMEOUT_SECONDS = 60.0
BLOCK = 1 << 20
SERVER_ERROR = 500


class PullError(Exception):
    pass


class Response(Protocol):
    def __enter__(self) -> Self: ...
    def __exit__(self, *exc: object) -> None: ...
    def read(self, size: int, /) -> bytes: ...


Opener = Callable[[urllib.request.Request], Response]
Clock = Callable[[], float]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(  # pyright: ignore[reportIncompatibleMethodOverride]
        self, req: urllib.request.Request, *_rest: object
    ) -> None:
        msg = f"refusing a redirect from {req.full_url}"
        raise PullError(msg)


def _urlopen(request: urllib.request.Request) -> Response:
    return urllib.request.build_opener(NoRedirect).open(request, timeout=TIMEOUT_SECONDS)


def _digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(BLOCK), b""):
            h.update(block)
    return h.hexdigest()


def _fetch(entry: Entry, opener: Opener, dest: Path, expires: float, clock: Clock) -> str:
    request = urllib.request.Request(entry.url, headers={"User-Agent": USER_AGENT})  # noqa: S310
    h = hashlib.sha256()
    with opener(request) as resp, dest.open("wb") as out:
        while block := resp.read(BLOCK):
            if clock() > expires:
                msg = f"{entry.slug} {entry.version}: passed its {DEADLINE_SECONDS:.0f}s deadline"
                raise PullError(msg)
            h.update(block)
            out.write(block)
        out.flush()
        os.fsync(out.fileno())
    return h.hexdigest()


def _download(
    entry: Entry, cache: Path, opener: Opener, sleep: Callable[[float], None], clock: Clock
) -> None:
    expires = clock() + DEADLINE_SECONDS
    for attempt in range(1, ATTEMPTS + 1):
        with tempfile.NamedTemporaryFile(dir=cache, prefix=".part-", delete=False) as tmp:
            part = Path(tmp.name)
        try:
            digest = _fetch(entry, opener, part, expires, clock)
            if digest != entry.sha256:
                msg = f"{entry.slug} {entry.version}: served sha256 {digest}, pinned {entry.sha256}"
                raise PullError(msg)  # noqa: TRY301
            part.replace(cache / entry.sha256)
        except urllib.error.HTTPError as err:
            part.unlink(missing_ok=True)
            if err.code < SERVER_ERROR and err.code not in RETRYABLE_CLIENT_ERRORS:
                msg = f"{entry.slug} {entry.version}: HTTP {err.code}"
                raise PullError(msg) from err
            failure: Exception = err
        except (OSError, http.client.HTTPException) as err:
            part.unlink(missing_ok=True)
            failure = err
        except BaseException:
            part.unlink(missing_ok=True)
            raise
        else:
            return
        if attempt == ATTEMPTS:
            msg = f"{entry.slug} {entry.version}: gave up after {ATTEMPTS} attempts: {failure!r}"
            raise PullError(msg) from failure
        sleep(min(BACKOFF_SECONDS * 2 ** (attempt - 1), BACKOFF_CAP_SECONDS))


def pull(
    entries: tuple[Entry, ...],
    cache: Path = CACHE_DIR,
    opener: Opener = _urlopen,
    sleep: Callable[[float], None] = time.sleep,
    clock: Clock = time.monotonic,
) -> dict[str, Path]:
    """Return each slug's verified file, downloading only what the cache lacks."""
    cache.mkdir(parents=True, exist_ok=True)
    for stale in cache.glob(".part-*"):
        stale.unlink()
    found: dict[str, Path] = {}
    for entry in entries:
        named = URL_FORM.fullmatch(entry.url)
        if named is None or named.groups() != (entry.slug, entry.version):
            msg = f"{entry.slug}: refusing a source outside publicdata.au"
            raise PullError(msg)
        target = cache / entry.sha256
        if target.is_file() and _digest(target) != entry.sha256:
            target.unlink()
        if not target.is_file():
            _download(entry, cache, opener, sleep, clock)
        found[entry.slug] = target
    return found


def main(
    argv: list[str] | None = None,
    opener: Opener = _urlopen,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    parser = argparse.ArgumentParser(description="Download and verify every pinned file.")
    parser.add_argument("--manifest", type=Path, default=MANIFEST_PATH)
    parser.add_argument("--cache", type=Path, default=CACHE_DIR)
    args = parser.parse_args(argv)
    try:
        files = pull(load(args.manifest), args.cache, opener, sleep)
    except (ManifestError, PullError) as err:
        sys.stderr.write(f"pull failed: {err}\n")
        return 1
    for slug, path in files.items():
        sys.stdout.write(f"{slug} {os.fspath(path)}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
