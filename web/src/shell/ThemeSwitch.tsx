import { useId, type ComponentType, type SVGProps } from "react";

import { MonitorIcon, MoonIcon, PawIcon, SunIcon } from "./icons.tsx";
import { THEME_CHOICES, type ThemeChoice } from "./theme.ts";
import { useTheme } from "./useTheme.ts";
import "./ThemeSwitch.css";

// =============================================================================
// Module Overview
// =============================================================================
// The theme picker: a row of radio buttons, one per `ThemeChoice`. Native
// radios give arrow key movement and the right announcements for free. The
// compact form shows icons only and keeps each label for screen readers.

const ICONS: Record<ThemeChoice, ComponentType<SVGProps<SVGSVGElement>>> = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
  umbc: PawIcon,
};

/** Picks the color theme; `compact` hides the labels. */
export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const { choice, choose } = useTheme();
  const name = useId();
  return (
    <fieldset className={`theme-switch ${compact ? "is-compact" : ""}`}>
      <legend className="visually-hidden">Theme</legend>
      {THEME_CHOICES.map(({ value, label }) => {
        const Glyph = ICONS[value];
        return (
          <label key={value} className="theme-option" title={label}>
            <input
              type="radio"
              name={name}
              value={value}
              checked={choice === value}
              onChange={() => choose(value)}
              className="visually-hidden"
            />
            <Glyph className="theme-icon" />
            <span className={compact ? "visually-hidden" : "theme-label"}>{label}</span>
          </label>
        );
      })}
    </fieldset>
  );
}
