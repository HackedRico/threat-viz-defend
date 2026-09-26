/// <reference types="vite/client" />

// =============================================================================
// Module Overview
// =============================================================================
// Types for the build-time environment variables the app reads.

interface ImportMetaEnv {
  /** Base URL of the API when it is hosted apart from the web app, such as `https://api.example.com`. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
