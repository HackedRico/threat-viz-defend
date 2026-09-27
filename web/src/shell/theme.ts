// =============================================================================
// Module Overview
// =============================================================================
// The app's color themes as plain values. A visitor picks a `ThemeChoice`;
// `resolveTheme` turns it into the `Theme` the page wears, following the
// system setting when the choice is "system". `useTheme.ts` stores the choice
// and puts the result on `<html data-theme>`, where `tokens.css` reads it.

/** A theme the page can wear. */
export type Theme = "light" | "dark" | "umbc";

/** What a visitor picks: a theme, or whatever their system prefers. */
export type ThemeChoice = Theme | "system";

/** Every choice in the order the switch shows them, with its label. */
export const THEME_CHOICES: readonly { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "umbc", label: "hackUMBC" },
];

/** The choice a stored value names, or "system" for anything unknown. */
export function parseThemeChoice(stored: string | null): ThemeChoice {
  return THEME_CHOICES.some((choice) => choice.value === stored) ? (stored as ThemeChoice) : "system";
}

/** The theme a choice resolves to, given whether the system prefers dark. */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): Theme {
  if (choice !== "system") return choice;
  return systemDark ? "dark" : "light";
}
