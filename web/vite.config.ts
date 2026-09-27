import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// =============================================================================
// Module Overview
// =============================================================================
// Vite build and dev server. In development `/api` and `/mcp` go to the backend
// on port 8000, or `API_PORT` when `scripts/dev.sh` moved it. A production build embeds a Content-Security-Policy meta tag,
// because a static host serving `dist` cannot be trusted to send our headers;
// it allows the API origin from `VITE_API_BASE_URL` and the voice hosts.

// `scripts/dev.sh` exports `API_PORT` when the API runs on another port.
const BACKEND = `http://127.0.0.1:${process.env.API_PORT ?? "8000"}`;

// The voice coach talks to LiveKit over WebRTC and to the ElevenLabs API host.
const VOICE_HOSTS = [
  "https://api.elevenlabs.io",
  "wss://api.elevenlabs.io",
  "https://livekit.rtc.elevenlabs.io",
  "wss://livekit.rtc.elevenlabs.io",
];

/** Add a CSP meta tag to the built `index.html`; dev keeps Vite's inline refresh scripts working. */
function contentSecurityPolicy(apiBase: string): Plugin {
  const apiOrigin = apiBase ? new URL(apiBase).origin : "";
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${[apiOrigin, ...VOICE_HOSTS].filter(Boolean).join(" ")}`,
    "media-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: policy }, injectTo: "head-prepend" }],
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [react(), contentSecurityPolicy(env.VITE_API_BASE_URL ?? "")],
    server: {
      port: 5173,
      proxy: {
        "/api": { target: BACKEND, changeOrigin: false },
        "/mcp": { target: BACKEND, changeOrigin: false },
      },
    },
    build: {
      target: "es2023",
      sourcemap: true,
      // Fonts must load from our own origin under `font-src 'self'`; inlining them as data URLs would break that.
      assetsInlineLimit: 0,
      // The layout engine and the voice SDK are large but load only on first use, in their own chunks.
      chunkSizeWarningLimit: 1500,
    },
  };
});
