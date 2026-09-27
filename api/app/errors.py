from typing import Literal

from pydantic import BaseModel

# =============================================================================
# Module Overview
# =============================================================================
# The error every route raises. `AppError` carries an HTTP status, a stable
# machine code and a message that tells the user what to do next; `main.py`
# renders it as `{"error": {"code", "message"}}`. The helpers below cover the
# statuses the API uses, so routes never build responses by hand.

ErrorCode = Literal[
    "bad_request",
    "invalid_request",
    "unauthorized",
    "forbidden",
    "not_found",
    "conflict",
    "rate_limited",
    "budget_exhausted",
    "payload_too_large",
    "model_error",
    "memory_error",
    "snowflake_error",
    "voice_error",
    "not_configured",
    "internal_error",
]


class ErrorBody(BaseModel):
    """The `error` object in every error response."""

    code: ErrorCode
    message: str


class ErrorResponse(BaseModel):
    """The body of every error response."""

    error: ErrorBody


class AppError(Exception):
    """An error with an HTTP status, a machine code and a message for the user."""

    def __init__(self, status: int, code: ErrorCode, message: str, *, headers: dict[str, str] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code: ErrorCode = code
        self.message = message
        self.headers = headers or {}


def bad_request(message: str) -> AppError:
    """400: the request is well formed but cannot be done as asked."""
    return AppError(400, "bad_request", message)


def unauthorized(message: str = "Sign in to continue.") -> AppError:
    """401: no valid session or token."""
    return AppError(401, "unauthorized", message)


def forbidden(message: str) -> AppError:
    """403: signed in, but not allowed."""
    return AppError(403, "forbidden", message)


def not_found(message: str) -> AppError:
    """404: the thing does not exist, or belongs to someone else."""
    return AppError(404, "not_found", message)


def conflict(message: str) -> AppError:
    """409: the thing is in the wrong state for this action."""
    return AppError(409, "conflict", message)


def too_many(message: str, retry_after_s: int) -> AppError:
    """429: slow down, and when to try again."""
    return AppError(429, "rate_limited", message, headers={"Retry-After": str(max(1, retry_after_s))})
