import { create } from "zustand";

import { parseThemeChoice, resolveTheme, type Theme, type ThemeChoice } from "./theme.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The theme store. It keeps the visitor's choice in this browser, puts the
// resolved theme on `<html data-theme>` for `tokens.css`, and follows the
// system setting live while the choice is "system". `public/theme-boot.js`
// sets the attribute before the first paint; `startTheme` takes over from it.

const STORAGE_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

interface ThemeStore {
  choice: ThemeChoice;
  theme: Theme;
  choose: (choice: ThemeChoice) => void;
}

function readChoice(): ThemeChoice {
  try {
    return parseThemeChoice(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage can be blocked in private windows; the page just follows the system.
    return "system";
  }
}

function systemDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

function wear(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

/** The current theme choice, the theme it resolves to, and a way to change it. */
export const useTheme = create<ThemeStore>()((set) => ({
  choice: "system",
  theme: "light",
  choose: (choice) => {
    try {
      localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // Unsaved, the choice still holds until the tab closes.
    }
    const theme = resolveTheme(choice, systemDark());
    wear(theme);
    set({ choice, theme });
  },
}));

/** Loads the saved choice into the store and starts following the system setting; call once before rendering. */
export function startTheme() {
  const choice = readChoice();
  const theme = resolveTheme(choice, systemDark());
  wear(theme);
  useTheme.setState({ choice, theme });
  window.matchMedia(DARK_QUERY).addEventListener("change", (event) => {
    const { choice: current } = useTheme.getState();
    if (current !== "system") return;
    const next = resolveTheme(current, event.matches);
    wear(next);
    useTheme.setState({ theme: next });
  });
}
