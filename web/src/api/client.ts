import createClient, { type Middleware } from "openapi-fetch";

import { API_BASE, apiUrl } from "./base.ts";
import { ApiError, networkError, toApiError } from "./errors.ts";
import type { paths } from "./schema";
import type { AnswerIn, LoginIn, MemoryIn, ProviderIn, SignupIn, SourceIn, SystemMap } from "./types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The typed API client. `http` is an openapi-fetch client generated from the
// server's schema, so a renamed route or changed body fails the typecheck.
// Every call goes to `API_BASE`, which may be another origin, with the session
// cookie. `unwrap` turns failures into `ApiError` and tells `onSignedOut`
// listeners when a call finds the session gone. `api` names each endpoint.

const signedOutListeners = new Set<() => void>();

/** Run `listener` whenever a call finds the session gone; returns the unsubscribe function. */
export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener);
  return () => signedOutListeners.delete(listener);
}

// The server refuses writes that are not JSON, which blocks cross-site form posts, so every
// write says it is JSON and carries at least `{}` even when the route takes no body.
const jsonWrites: Middleware = {
  onRequest({ request }) {
    if (request.method === "GET") return undefined;
    const headers = new Headers(request.headers);
    headers.set("Content-Type", "application/json");
    return new Request(request, { headers, ...(request.body === null ? { body: "{}" } : {}) });
  },
};

// `include` sends the session cookie to an API on a sibling subdomain as well as to this origin.
const http = createClient<paths>({ baseUrl: API_BASE, credentials: "include", headers: { Accept: "application/json" } });
http.use(jsonWrites);

interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/** Await an openapi-fetch call and return its data, or throw an `ApiError`. */
async function unwrap<T>(call: Promise<FetchResult<T>>): Promise<T> {
  let result: FetchResult<T>;
  try {
    result = await call;
  } catch (cause) {
    throw networkError(cause);
  }
  const { response } = result;
  if (response.ok) return result.data as T;
  const error = toApiError(response.status, result.error, response.headers.get("Retry-After"));
  // The sign in call answers 401 for a wrong password; that is not a lost session.
  if (error.signedOut && !new URL(response.url, location.origin).pathname.startsWith("/api/auth/")) {
    signedOutListeners.forEach((listener) => listener());
  }
  throw error;
}

const path = (board_id: string) => ({ params: { path: { board_id } } });

/** Every endpoint the app calls. */
export const api = {
  config: () => unwrap(http.GET("/api/config")),

  me: () => unwrap(http.GET("/api/auth/me")),
  login: (body: LoginIn) => unwrap(http.POST("/api/auth/login", { body })),
  signup: (body: SignupIn) => unwrap(http.POST("/api/auth/signup", { body })),
  logout: () => unwrap(http.POST("/api/auth/logout")),

  boards: () => unwrap(http.GET("/api/boards")),
  createBoard: (title: string) => unwrap(http.POST("/api/boards", { body: { title } })),
  restoreExample: () => unwrap(http.POST("/api/boards/example")),
  board: (id: string) => unwrap(http.GET("/api/boards/{board_id}", path(id))),
  renameBoard: (id: string, title: string) =>
    unwrap(http.PATCH("/api/boards/{board_id}", { ...path(id), body: { title } })),
  deleteBoard: (id: string) => unwrap(http.DELETE("/api/boards/{board_id}", path(id))),
  addSources: (id: string, sources: SourceIn[]) =>
    unwrap(http.POST("/api/boards/{board_id}/sources", { ...path(id), body: { sources } })),
  addGithub: (id: string, url: string) =>
    unwrap(http.POST("/api/boards/{board_id}/github", { ...path(id), body: { url } })),
  saveMap: (id: string, map: SystemMap) => unwrap(http.PUT("/api/boards/{board_id}/map", { ...path(id), body: { map } })),
  confirm: (id: string) => unwrap(http.POST("/api/boards/{board_id}/confirm", path(id))),
  ask: (id: string, question: string, focus: string | null) =>
    unwrap(http.POST("/api/boards/{board_id}/ask", { ...path(id), body: { question, focus } })),
  report: (id: string) => downloadText(apiUrl(`/api/boards/${encodeURIComponent(id)}/report.md`)),

  quiz: (id: string) => unwrap(http.GET("/api/boards/{board_id}/quiz", path(id))),
  answer: (id: string, body: AnswerIn) =>
    unwrap(http.POST("/api/boards/{board_id}/quiz/answers", { ...path(id), body })),
  resetQuiz: (id: string) => unwrap(http.DELETE("/api/boards/{board_id}/quiz", path(id))),

  brief: (id: string) => unwrap(http.GET("/api/boards/{board_id}/brief", path(id))),
  voiceSession: (id: string) => unwrap(http.POST("/api/boards/{board_id}/voice", path(id))),

  provider: () => unwrap(http.GET("/api/provider")),
  saveProvider: (body: ProviderIn) => unwrap(http.PUT("/api/provider", { body })),
  testProvider: (body: ProviderIn) => unwrap(http.POST("/api/provider/test", { body })),
  resetProvider: () => unwrap(http.DELETE("/api/provider")),

  memory: () => unwrap(http.GET("/api/memory")),
  saveMemory: (body: MemoryIn) => unwrap(http.PUT("/api/memory", { body })),
  testMemory: (body: MemoryIn) => unwrap(http.POST("/api/memory/test", { body })),
  resetMemory: () => unwrap(http.DELETE("/api/memory")),

  tokens: () => unwrap(http.GET("/api/tokens")),
  createToken: (name: string) => unwrap(http.POST("/api/tokens", { body: { name } })),
  deleteToken: (token_id: string) => unwrap(http.DELETE("/api/tokens/{token_id}", { params: { path: { token_id } } })),
};

/** Fetch a text file with the session cookie, for downloads from an API that may be on another origin. */
async function downloadText(url: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "include" });
  } catch (cause) {
    throw networkError(cause);
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw toApiError(response.status, body, response.headers.get("Retry-After"));
  }
  return response.blob();
}

/** The message to show for any thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Try again.";
}

export { ApiError };
