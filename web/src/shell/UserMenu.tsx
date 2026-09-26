import { useEffect, useId, useRef, useState } from "react";

import type { UsageOut } from "../api/types.ts";
import { navigate } from "./useRoute.ts";
import { LogoutIcon, PlugIcon, SparkIcon } from "./icons.tsx";
import { useSession } from "./session.tsx";
import "./UserMenu.css";

// =============================================================================
// Module Overview
// =============================================================================
// The account menu at the foot of the sidebar: who is signed in, what they have
// spent today against their limits, a way to connect a coding agent, and sign
// out. Usage refreshes each time the menu opens.

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <div className="usage-meter">
      <div className="usage-row">
        <span>{label}</span>
        <span className="mono">
          {used} of {limit}
        </span>
      </div>
      <div className={`usage-track ${ratio >= 0.9 ? "is-near" : ""}`} role="presentation">
        <div className="usage-fill" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

/** Today's usage as meters; dictation shows only where the server offers it. */
export function UsageMeters({ usage, dictation }: { usage: UsageOut; dictation: boolean }) {
  return (
    <div className="usage">
      <Meter label="Model calls today" used={usage.model_calls_today} limit={usage.model_calls_limit} />
      <Meter label="Voice sessions today" used={usage.voice_sessions_today} limit={usage.voice_sessions_limit} />
      {dictation && <Meter label="Dictations today" used={usage.dictations_today} limit={usage.dictations_limit} />}
    </div>
  );
}

/** The account button and its menu; `collapsed` shows only the initial. */
export function UserMenu({ collapsed, boardId }: { collapsed: boolean; boardId: string | null }) {
  const { config, me, refreshMe, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    refreshMe();
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, refreshMe]);

  const name = me.user.username;
  return (
    <div className="user-menu" ref={root}>
      {open && (
        <div className="user-pop" id={menuId} role="group" aria-label="Account">
          <p className="user-pop-name">
            Signed in as <strong>{name}</strong>
          </p>
          <UsageMeters usage={me.usage} dictation={config.dictation_enabled} />
          <button
            type="button"
            className="btn btn-ghost user-pop-item"
            onClick={() => {
              setOpen(false);
              navigate({ name: "settings", section: "agents", boardId });
            }}
          >
            <PlugIcon /> Connect a coding agent
          </button>
          <button
            type="button"
            className="btn btn-ghost user-pop-item"
            onClick={() => {
              setOpen(false);
              navigate({ name: "settings", section: "provider", boardId });
            }}
          >
            <SparkIcon /> Model provider
          </button>
          <button type="button" className="btn btn-ghost user-pop-item" onClick={() => void signOut()}>
            <LogoutIcon /> Sign out
          </button>
        </div>
      )}
      <button
        type="button"
        className="user-button"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={collapsed ? `Account menu for ${name}` : undefined}
        onClick={() => setOpen((shown) => !shown)}
      >
        <span className="user-avatar" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </span>
        {!collapsed && (
          <span className="user-meta">
            <span className="user-name">{name}</span>
            <span className="user-usage">
              {me.usage.model_calls_today}/{me.usage.model_calls_limit} model calls today
            </span>
          </span>
        )}
      </button>
    </div>
  );
}
