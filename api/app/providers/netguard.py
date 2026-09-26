import ipaddress
import socket
from collections.abc import Callable
from urllib.parse import urlparse

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


def resolve(host: str, port: int) -> list[str]:
    """Every IP address `host` resolves to."""
    infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    return sorted({str(info[4][0]) for info in infos})


def check_base_url(url: str, *, allow_private: bool, resolver: Resolver = resolve) -> str:
    """Validate a provider base URL and return it without a trailing slash, or raise 400 saying why."""
    parsed = urlparse(url.strip())
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
        try:
            addresses = resolver(parsed.hostname, port)
        except OSError as exc:
            raise bad_request(f"The host {parsed.hostname} does not resolve. Check the URL.") from exc
        if not addresses or any(not _public(a) for a in addresses):
            raise bad_request("The base URL points at a private or local address, which this server does not allow.")
    return url.strip().rstrip("/")


def _public(address: str) -> bool:
    """True when `address` is a globally routable IP."""
    ip = ipaddress.ip_address(address)
    return ip.is_global and not ip.is_multicast
