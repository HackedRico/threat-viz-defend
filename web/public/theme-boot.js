// =============================================================================
// Module Overview
// =============================================================================
// Puts the saved theme on `<html data-theme>` before the first paint, so a choice
// that differs from the system never flashes the wrong colors. A classic script
// in `<head>` runs before the app bundle; `useTheme.ts` takes over once the app
// starts. The key and values match `web/src/shell/theme.ts`.
(function () {
  var choice = null;
  try {
    choice = localStorage.getItem("theme");
  } catch (error) {
    // Blocked storage only means the page follows the system.
  }
  var picked = choice === "light" || choice === "dark" || choice === "umbc";
  var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = picked ? choice : dark ? "dark" : "light";
})();
