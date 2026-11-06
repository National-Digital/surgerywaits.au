import ipaddress
import socket
from collections.abc import Callable
from typing import Any, cast

import pytest

LOOPBACK = {"localhost", "127.0.0.1", "::1"}


def _local(host: object) -> bool:
    if isinstance(host, bytes):
        host = host.decode()
    if not isinstance(host, str):
        return False
    if host in LOOPBACK:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


METHODS = ("connect", "connect_ex", "sendto", "sendmsg")
LOOKUPS = ("getaddrinfo", "gethostbyname", "gethostbyname_ex", "gethostbyaddr", "getnameinfo")
ORIGINAL_METHODS = {name: getattr(socket.socket, name) for name in METHODS}
ORIGINAL_LOOKUPS = {name: getattr(socket, name) for name in LOOKUPS}
SENDMSG_ADDRESS = 3


def _destination(name: str, args: tuple[Any, ...]) -> Any:  # noqa: ANN401 - addresses vary by family
    # None means a connected socket, which has no address to check.
    if name == "sendto":
        return args[-1]
    if name == "sendmsg":
        return args[SENDMSG_ADDRESS] if len(args) > SENDMSG_ADDRESS else None
    return args[0]


def _refuse(target: object) -> RuntimeError:
    return RuntimeError(
        f"tests never touch the network: refused {target!r}; use pipeline/tests/fixtures"
    )


def _guard_method(name: str) -> Callable[..., Any]:
    def guarded(self: socket.socket, *args: Any) -> Any:  # noqa: ANN401 - mirrors the stdlib
        address = _destination(name, args)
        if address is not None and self.family != socket.AF_UNIX and not _local(address[0]):
            raise _refuse(address)
        return ORIGINAL_METHODS[name](self, *args)

    return guarded


def _guard_lookup(name: str) -> Callable[..., Any]:
    def guarded(host: Any, *args: Any, **kwargs: Any) -> Any:  # noqa: ANN401 - mirrors the stdlib
        # getnameinfo takes an address tuple
        target: object = cast("tuple[object, ...]", host)[0] if isinstance(host, tuple) else host
        if target is not None and not _local(target):
            raise _refuse(cast("object", host))
        return ORIGINAL_LOOKUPS[name](host, *args, **kwargs)

    return guarded


# The guard covers pytest only; subprocesses and C extensions open sockets it cannot see.
@pytest.fixture(autouse=True)
def _no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in METHODS:
        monkeypatch.setattr(socket.socket, name, _guard_method(name))
    for name in LOOKUPS:
        monkeypatch.setattr(socket, name, _guard_lookup(name))
