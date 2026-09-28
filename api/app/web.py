import json
from pathlib import Path
from urllib.parse import urlparse

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.config import Settings

# =============================================================================
# Module Overview
# =============================================================================
# The HTTP guard every request passes. `RequestGuard` caps body size, rejects
# cross-site writes to cookie-authenticated routes, requires JSON bodies, and
# stamps security headers such as a strict Content-Security-Policy on every
# response. `spa_file` picks what to serve for a browser path.

MAX_BODY_BYTES = 2_500_000
_TOO_LARGE = "That upload is too large. Send fewer or smaller files."
_UNSAFE = frozenset({"POST", "PUT", "PATCH", "DELETE"})
# Token-authenticated paths: no cookie rides along, so cross-site request forgery cannot reach them.
_TOKEN_PATHS = ("/api/agent/", "/mcp")
# The voice coach talks to LiveKit over WebRTC, and to the API host for a signed URL fallback.
ELEVENLABS_CONNECT = (
    "https://api.elevenlabs.io",
    "wss://api.elevenlabs.io",
    "https://livekit.rtc.elevenlabs.io",
    "wss://livekit.rtc.elevenlabs.io",
)


def content_security_policy() -> str:
    """The CSP for every page: our own origin only, plus the ElevenLabs hosts the voice coach talks to."""
    return "; ".join(
        [
            "default-src 'self'",
            # The voice SDK's audio worklets are self-hosted under /vendor, so no blob: scripts are needed.
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self'",
            f"connect-src 'self' {' '.join(ELEVENLABS_CONNECT)}",
            "media-src 'self' blob:",
            "frame-ancestors 'none'",
            "base-uri 'none'",
            "form-action 'self'",
            "object-src 'none'",
        ]
    )


class RequestGuard:
    """ASGI middleware: body cap, cross-site write checks, JSON-only writes and security headers."""

    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self._settings = settings
        self._headers = self._security_headers()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Check the request, then pass it on with a byte-counting `receive` and a header-adding `send`."""
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        problem = self._host_problem(scope, headers) or self._reject_reason(scope, headers)
        if problem is not None:
            status, code, message = problem
            await _send_error(send, status, code, message, self._headers)
            return

        received = 0
        too_large = False
        answered = False

        async def counted_receive() -> Message:
            nonlocal received, too_large
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > MAX_BODY_BYTES:
                    too_large = True
                    raise _BodyTooLargeError
            return message

        async def secured_send(message: Message) -> None:
            nonlocal answered
            if too_large:
                # FastAPI turns an error while reading the body into its own 400, so that reply is swapped for a 413.
                if message["type"] == "http.response.start" and not answered:
                    answered = True
                    await _send_error(send, 413, "payload_too_large", _TOO_LARGE, self._headers)
                return
            answered = answered or message["type"] == "http.response.start"
            if message["type"] == "http.response.start":
                existing = {k.lower() for k, _ in message.get("headers", [])}
                extra = [(k, v) for k, v in self._headers if k not in existing]
                message = {**message, "headers": [*message.get("headers", []), *extra]}
            await send(message)

        try:
            await self.app(scope, counted_receive, secured_send)
        except _BodyTooLargeError:
            if not answered:
                await _send_error(send, 413, "payload_too_large", _TOO_LARGE, self._headers)

    def _host_problem(self, scope: Scope, headers: Headers) -> tuple[int, str, str] | None:
        """Refuse unknown Host headers, which blocks DNS rebinding; health checks from the platform are exempt."""
        # Platform health checkers may call by internal address, and the health route reveals nothing.
        if scope["path"] == "/api/health":
            return None
        host = headers.get("host", "").rsplit(":", 1)[0].strip("[]").lower()
        if host in self._settings.allowed_hosts:
            return None
        return 400, "bad_request", "Invalid host header."

    def _reject_reason(self, scope: Scope, headers: Headers) -> tuple[int, str, str] | None:
        """Why a request must be refused before it reaches a route, or `None`."""
        length = headers.get("content-length")
        if length is not None and (not length.isdigit() or int(length) > MAX_BODY_BYTES):
            return 413, "payload_too_large", _TOO_LARGE
        path: str = scope["path"]
        method: str = scope["method"]
        if method not in _UNSAFE or not path.startswith("/api/") or path.startswith(_TOKEN_PATHS):
            return None
        origin = headers.get("origin")
        if origin is not None and not self._origin_allowed(origin):
            return 403, "forbidden", "Requests must come from this site."
        # Browsers label cross-site requests; a forged form post from another site stops here unless
        # it comes from a frontend origin listed in `CORS_ORIGINS`.
        if headers.get("sec-fetch-site") == "cross-site" and origin not in self._settings.trusted_origins:
            return 403, "forbidden", "Cross-site requests are not allowed."
        # A chunked body has no Content-Length, so a Transfer-Encoding header counts as a body too.
        has_body = method != "DELETE" and (
            headers.get("content-length", "0") != "0" or headers.get("transfer-encoding") is not None
        )
        if has_body and not headers.get("content-type", "").startswith("application/json"):
            return 415, "bad_request", "Send the request body as JSON."
        return None

    def _origin_allowed(self, origin: str) -> bool:
        """True when `origin` is this site."""
        if origin in self._settings.trusted_origins:
            return True
        host = urlparse(origin).hostname
        return not self._settings.production and host in self._settings.allowed_hosts

    def _security_headers(self) -> list[tuple[bytes, bytes]]:
        """Headers added to every response."""
        headers = {
            "content-security-policy": content_security_policy(),
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            "x-frame-options": "DENY",
            "cross-origin-opener-policy": "same-origin",
            "permissions-policy": "microphone=(self), camera=(), geolocation=(), payment=()",
        }
        if self._settings.cookie_secure:
            headers["strict-transport-security"] = "max-age=31536000; includeSubDomains"
        return [(k.encode(), v.encode()) for k, v in headers.items()]


class _BodyTooLargeError(Exception):
    """Raised inside `receive` when a streamed body passes the cap."""


async def _send_error(send: Send, status: int, code: str, message: str, headers: list[tuple[bytes, bytes]]) -> None:
    """Answer with the API's error shape without touching the app."""
    body = json.dumps({"error": {"code": code, "message": message}}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()), *headers],
        }
    )
    await send({"type": "http.response.body", "body": body})


def spa_file(static_dir: Path, path: str) -> Path | None:
    """The file to serve for a browser path: a real asset, or `index.html` for client-side routes."""
    root = static_dir.resolve()
    candidate = (root / path.lstrip("/")).resolve()
    # Resolving first and checking the parent stops `..` from escaping the build folder.
    if candidate.is_relative_to(root) and candidate.is_file():
        return candidate
    index = root / "index.html"
    return index if index.is_file() else None
