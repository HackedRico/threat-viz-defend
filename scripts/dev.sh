#!/usr/bin/env bash
# =============================================================================
# Module Overview
# =============================================================================
# Starts the whole app locally without Docker: the API on http://localhost:8000
# and the web app on http://localhost:5173. It creates `.env` from
# `.env.example` on first run, installs dependencies when they are missing, and
# stops both servers together on Ctrl+C or when either one exits.
#
#   ./scripts/dev.sh           start both
#   ./scripts/dev.sh --api     API only
#   ./scripts/dev.sh --web     web app only

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-5173}"
RUN_API=true
RUN_WEB=true

case "${1:-}" in
  --api) RUN_WEB=false ;;
  --web) RUN_API=false ;;
  "") ;;
  -h|--help) sed -n 6,13p "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "Unknown option $1. Use --api, --web or no option." >&2; exit 2 ;;
esac

fail() { echo "dev: $*" >&2; exit 1; }

# ---------- prerequisites ----------
if $RUN_API; then
  command -v uv >/dev/null || fail "uv is not installed. See https://docs.astral.sh/uv/ (on macOS: brew install uv)."
fi
if $RUN_WEB; then
  command -v npm >/dev/null || fail "Node 24 and npm are not installed. See https://nodejs.org/."
fi
for port in $($RUN_API && echo "$API_PORT") $($RUN_WEB && echo "$WEB_PORT"); do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "port $port is already in use. Stop whatever is running there, or set API_PORT or WEB_PORT."
  fi
done

# ---------- first run setup ----------
if [ ! -f "$ROOT/.env" ]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "dev: created .env from .env.example. Sign in with DEV_USERNAME and DEV_PASSWORD from it."
fi
if $RUN_API && [ ! -d "$ROOT/api/.venv" ]; then
  echo "dev: installing API dependencies..."
  (cd "$ROOT/api" && uv sync)
fi
if $RUN_WEB && [ ! -d "$ROOT/web/node_modules" ]; then
  echo "dev: installing web dependencies..."
  (cd "$ROOT/web" && npm install)
fi

# ---------- run ----------
pids=()
stop() {
  trap - INT TERM EXIT
  # The `+` form keeps bash 3.2, the macOS default, from failing on an empty array under `set -u`.
  for pid in ${pids[@]+"${pids[@]}"}; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap stop INT TERM EXIT

if $RUN_API; then
  (cd "$ROOT/api" && exec uv run uvicorn app.main:app_from_env --factory --reload --port "$API_PORT") &
  pids+=($!)
fi
if $RUN_WEB; then
  (cd "$ROOT/web" && exec npm run dev -- --port "$WEB_PORT" --strictPort) &
  pids+=($!)
fi

echo "dev: API on http://localhost:$API_PORT, web app on http://localhost:$WEB_PORT. Ctrl+C stops both."
# Whichever server exits first, for a crash or Ctrl+C, takes the other one down with it.
# Polling instead of `wait -n` keeps this working on bash 3.2.
while true; do
  for pid in "${pids[@]}"; do
    kill -0 "$pid" 2>/dev/null || exit 0
  done
  sleep 1
done
