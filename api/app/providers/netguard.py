import ipaddress
import socket
import threading
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any
from urllib.parse import urlparse

import httpx

from app.errors import bad_request

# =============================================================================
# Module Overview
# =============================================================================
# Users type the base URL of their model provider, and the server then calls
# it, which invites server-side request forgery. `check_base_url` allows only
# https URLs whose host resolves to public addresses, unless the deployment
# opts into private ones for a local model. The address is checked when the
# setting is saved and again before each use; DNS is not pinned between the
# check and the call, which docs/security.md lists as a known limit.

Resolver = Callable[[str, int], list[str]]

# A user controls the nameserver for their saved host, so a lookup gets a few seconds, never the resolver's own
# minutes, and at most a few lookups hold threads at once; the rest wait their turn and time out the same way.
DNS_TIMEOUT_S = 3.0
_lookups = ThreadPoolExecutor(max_workers=4, thread_name_prefix="dns")
# Requests for a host already being looked up share that lookup, so one stalling host holds one thread, not all.
_in_flight: dict[tuple[str, int], Future[list[tuple[Any, ...]]]] = {}
_in_flight_lock = threading.Lock()
_NAT64 = ipaddress.ip_network("64:ff9b::/96")
_SITE_LOCAL = ipaddress.ip_network("fec0::/10")


def resolve(host: str, port: int) -> list[str]:
    """Every IP address `host` resolves to; `OSError` when it does not resolve within `DNS_TIMEOUT_S`."""
    with _in_flight_lock:
        future = _in_flight.get((host, port))
        started = future is None
        if future is None:
            future = _lookups.submit(socket.getaddrinfo, host, port, proto=socket.IPPROTO_TCP)
            _in_flight[(host, port)] = future
    if started:
        # Outside the lock: a lookup that already finished, such as an IP literal, runs the callback right here,
        # and `_forget` takes the same lock, which is not reentrant.
        future.add_done_callback(lambda done: _forget(host, port, done))
    try:
        infos = future.result(timeout=DNS_TIMEOUT_S)
    except TimeoutError as exc:
        raise OSError(f"Looking up {host} took too long.") from exc
    return sorted({str(info[4][0]) for info in infos})


def _forget(host: str, port: int, done: Future[list[tuple[Any, ...]]]) -> None:
    """Drop a finished lookup, so the next request resolves the host afresh."""
    with _in_flight_lock:
        if _in_flight.get((host, port)) is done:
            del _in_flight[(host, port)]


def check_base_url(url: str, *, allow_private: bool, resolver: Resolver = resolve) -> str:
    """Validate a provider base URL and return it without a trailing slash, or raise 400 saying why."""
    try:
        parsed = urlparse(url.strip())
    except ValueError as exc:
        raise bad_request("The base URL is not a valid URL, such as https://api.openai.com/v1.") from exc
    if parsed.scheme not in ("https", "http"):
        raise bad_request("The base URL must start with https://.")
    if parsed.scheme == "http" and not allow_private:
        raise bad_request("The base URL must use https.")
    if parsed.username or parsed.password:
        raise bad_request("Put the API key in the key field, not in the URL.")
    if not parsed.hostname or parsed.query or parsed.fragment:
        raise bad_request("The base URL needs a host and no query string, such as https://api.openai.com/v1.")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise bad_request("The base URL has an invalid port.") from exc
    if not allow_private:
        host = _connect_host(url.strip(), parsed.hostname)
        try:
            addresses = resolver(host, port)
        except (OSError, ValueError) as exc:
            # `ValueError` covers names the IDNA codec refuses, such as a label over 63 characters.
            raise bad_request(f"The host {parsed.hostname} does not resolve. Check the URL.") from exc
        if not addresses or any(not _public(a) for a in addresses):
            raise bad_request("The base URL points at a private or local address, which this server does not allow.")
    return url.strip().rstrip("/")


def _connect_host(url: str, hostname: str) -> str:
    """The host name the model client will look up, in the ASCII form httpx sends to DNS."""
    # getaddrinfo encodes a Unicode name with IDNA 2003 and httpx with IDNA 2008, which can spell it differently
    # (straße.example is strasse.example to one and xn--strae-oqa.example to the other), so resolve what httpx uses.
    try:
        return httpx.URL(url).raw_host.decode("ascii")
    except (httpx.InvalidURL, UnicodeError) as exc:
        raise bad_request(f"The host {hostname} is not a valid name. Check the URL.") from exc


def _public(address: str) -> bool:
    """True when `address` is a globally routable IP."""
    ip = ipaddress.ip_address(address)
    if isinstance(ip, ipaddress.IPv6Address):
        # NAT64 carries an IPv4 address in its last 32 bits; site-local is deprecated but still routed privately.
        if ip in _NAT64:
            return _public(str(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)))
        if ip in _SITE_LOCAL:
            return False
    return ip.is_global and not ip.is_multicast
