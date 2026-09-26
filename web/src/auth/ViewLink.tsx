import type { AnchorHTMLAttributes, MouseEvent } from "react";

import { navigatePath } from "../shell/useRoute.ts";
import { authViewPath, type AuthView } from "./authView.ts";

// =============================================================================
// Module Overview
// =============================================================================
// A link between the signed-out screens. A plain click switches screens in
// place; a modified or middle click keeps the browser's own behavior, such as
// opening the screen in a new tab.

type ViewLinkProps = { view: AuthView } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">;

/** A link to a signed-out screen. */
export function ViewLink({ view, onClick, ...props }: ViewLinkProps) {
  const follow = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigatePath(authViewPath(view));
  };
  return <a {...props} href={authViewPath(view)} onClick={follow} />;
}
