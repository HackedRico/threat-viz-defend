# Web app

`npm install`, then `npm run dev` (port 5173, proxies `/api` and `/mcp` to the backend on 8000). Set `VITE_API_BASE_URL` (see `.env.example`) when the API is on another domain.

`npm run typecheck`, `npm test` (node:test over the pure `.ts` modules), `npm run build` (to `dist/`), `npm run gen:api` (regenerate `src/api/schema.d.ts` from the backend).

- `src/api/` client, generated types and the API base URL
- `src/board/` canvas, ELK layout, inspector, intake and panels
- `src/quiz/` text quiz; `src/voice/` voice coach (see its AGENTS.md)
- `src/auth/`, `src/settings/` (coding agents, model provider), `src/shell/` sidebar, routing, session
- `src/styles/tokens.css` holds every design token
