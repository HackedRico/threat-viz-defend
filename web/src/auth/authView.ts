// =============================================================================
// Module Overview
// =============================================================================
// Which screen a signed-out visitor sees for a URL path, as an `AuthView`.
// `/` is the home page and `/signin` and `/signup` hold the account forms. Any
// other path asks to sign in first, so a link into the app, such as the board
// review links coding agents print, still opens once the visitor signs in.

/** A screen shown before signing in. */
export type AuthView = "home" | "signin" | "signup";

const PATHS: Record<AuthView, string> = { home: "/", signin: "/signin", signup: "/signup" };

/** The signed-out screen for a URL path. */
export function authView(pathname: string): AuthView {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return "home";
  if (parts.length === 1 && parts[0] === "signup") return "signup";
  return "signin";
}

/** The URL path of a signed-out screen. */
export function authViewPath(view: AuthView): string {
  return PATHS[view];
}

/** True for `/signin` and `/signup`, which give way to the app's home once the visitor signs in. */
export function isFormPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length === 1 && (parts[0] === "signin" || parts[0] === "signup");
}
