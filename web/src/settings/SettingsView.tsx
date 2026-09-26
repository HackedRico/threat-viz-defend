import type { SettingsSection } from "../shell/route.ts";
import { navigate } from "../shell/useRoute.ts";
import { ConnectAgent } from "./ConnectAgent.tsx";
import { ProviderSettings } from "./ProviderSettings.tsx";
import "./SettingsView.css";

// =============================================================================
// Module Overview
// =============================================================================
// The settings page: connecting coding agents and choosing the model provider,
// as two sections under one set of tabs. The board id rides along so agent
// setup can name the board the user came from.

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "agents", label: "Coding agents" },
  { id: "provider", label: "Model provider" },
];

/** The settings page open at `section`. */
export function SettingsView({ section, boardId }: { section: SettingsSection; boardId: string | null }) {
  return (
    <div className="connect">
      <div className="connect-inner">
        <nav className="settings-tabs" aria-label="Settings">
          {SECTIONS.map((item) => (
            <a
              key={item.id}
              href={item.id === "provider" ? "/settings/provider" : "/settings"}
              className="settings-tab"
              aria-current={section === item.id ? "page" : undefined}
              onClick={(event) => {
                event.preventDefault();
                navigate({ name: "settings", section: item.id, boardId });
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
        {section === "provider" ? <ProviderSettings /> : <ConnectAgent boardId={boardId} />}
      </div>
    </div>
  );
}
