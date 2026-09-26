// =============================================================================
// Module Overview
// =============================================================================
// Turns any failed response into one `ApiError` with a message fit to show the
// user. The server sends `{"error": {"code", "message"}}`; anything else, such
// as a proxy page or a dropped connection, gets a plain fallback message.

/** A failed API call: HTTP status, the server's stable code and a message for the user. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: number | null;

  constructor(status: number, code: string, message: string, retryAfter: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }

  /** True when the session is gone and the user has to sign in again. */
  get signedOut(): boolean {
    return this.status === 401;
  }
}

const FALLBACK: Record<number, string> = {
  401: "Sign in to continue.",
  403: "You are not allowed to do that.",
  404: "That was not found. It may have been deleted.",
  413: "That is too large to upload.",
  429: "Too many requests.",
};

/** Build an `ApiError` from a status, a parsed body of unknown shape and the `Retry-After` header. */
export function toApiError(status: number, body: unknown, retryAfterHeader: string | null): ApiError {
  const retryAfter = parseRetryAfter(retryAfterHeader);
  const parsed = readErrorBody(body);
  const code = parsed?.code ?? (status === 0 ? "network" : `http_${status}`);
  let message = parsed?.message ?? FALLBACK[status] ?? defaultMessage(status);
  if (status === 429 && retryAfter !== null && !/\bseconds?\b|\bminutes?\b/.test(message)) {
    message = `${message} Try again in ${formatWait(retryAfter)}.`;
  }
  return new ApiError(status, code, message, retryAfter);
}

/** The error a dropped connection or blocked request becomes. */
export function networkError(cause: unknown): ApiError {
  const error = new ApiError(0, "network", "Could not reach the server. Check your connection and try again.");
  error.cause = cause;
  return error;
}

/** Say how long to wait in words, such as `30 seconds` or `2 minutes`. */
export function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function readErrorBody(body: unknown): { code: string; message: string } | null {
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  const inner = (body as { error: unknown }).error;
  if (typeof inner !== "object" || inner === null) return null;
  const { code, message } = inner as { code?: unknown; message?: unknown };
  if (typeof message !== "string" || message.trim() === "") return null;
  // Server messages mark names like `LLM_API_KEY` with backticks for logs; show them as plain text.
  return { code: typeof code === "string" ? code : "error", message: message.replaceAll("`", "") };
}

function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number.parseInt(header, 10);
  // Retry-After may also be an HTTP date; the server only sends seconds, so a date reads as unknown.
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function defaultMessage(status: number): string {
  if (status === 0) return "Could not reach the server. Check your connection and try again.";
  if (status >= 500) return "The server hit a problem. Try again in a moment.";
  return "The request did not work.";
}
