import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource/caveat/latin-600.css";
import "@fontsource/caveat/latin-700.css";
import "@fontsource-variable/instrument-sans/wght.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles/tokens.css";
import "./styles/base.css";

import { App } from "./App.tsx";

// =============================================================================
// Module Overview
// =============================================================================
// Entry point: loads self-hosted fonts and global styles, then mounts `App`.

const root = document.getElementById("root");
if (root === null) throw new Error("index.html is missing the `#root` element.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
