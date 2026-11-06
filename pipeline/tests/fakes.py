import hashlib
import http.client
import urllib.error
import urllib.request
from typing import TYPE_CHECKING, Self

from surgerywaits.manifest import Entry

if TYPE_CHECKING:
    from collections.abc import Callable

BODY = b"parquet bytes" * 1000
GOOD = hashlib.sha256(BODY).hexdigest()


def make_entry(sha256: str = GOOD) -> Entry:
    return Entry(
        slug="demo",
        version="2026-01-02",
        release=None,
        as_at=None,
        licence="CC-BY-4.0",
        attribution="A publisher.",
        citation="A publisher.",
        url="https://publicdata.au/d/demo/v/2026-01-02/data.parquet",
        sha256=sha256,
    )


class FakeResponse:
    def __init__(self, body: bytes, *, fail_after: int | None = None) -> None:
        self.body = body
        self.sent = 0
        self.fail_after = fail_after
        self.on_read: Callable[[], None] | None = None

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def read(self, size: int, /) -> bytes:
        if self.on_read:
            self.on_read()
        if self.fail_after is not None and self.sent >= self.fail_after:
            raise http.client.IncompleteRead(self.body[: self.sent])
        chunk = self.body[self.sent : self.sent + min(size, 4096)]
        self.sent += len(chunk)
        return chunk


class FakeOpener:
    def __init__(self, *script: FakeResponse | Exception) -> None:
        self.script = list(script)
        self.requests: list[urllib.request.Request] = []

    def __call__(self, request: urllib.request.Request) -> FakeResponse:
        self.requests.append(request)
        step = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        if isinstance(step, Exception):
            raise step
        resp = FakeResponse(step.body, fail_after=step.fail_after)
        resp.on_read = step.on_read
        return resp


class Sleeps:
    def __init__(self) -> None:
        self.waits: list[float] = []

    def __call__(self, seconds: float) -> None:
        self.waits.append(seconds)


def http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://publicdata.au/", code, "x", None, None)  # pyright: ignore[reportArgumentType]
