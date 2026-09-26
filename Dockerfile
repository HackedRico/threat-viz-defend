# syntax=docker/dockerfile:1

# ThreatViz Defend container images, built from the repo root.
#
#   docker build -t threatviz-api .                 API only (default, used by App Platform)
#   docker build --target full -t threatviz-full .  API plus the built web app on one origin
#
# The default target is the last stage, so App Platform, which has no target
# setting, builds the API-only image.

ARG PYTHON_IMAGE=python:3.12-slim

# -----------------------------------------------------------------------------
# uv binary, pinned
# -----------------------------------------------------------------------------
FROM ghcr.io/astral-sh/uv:0.12.19 AS uv

# -----------------------------------------------------------------------------
# Python dependencies into /opt/venv
# -----------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS deps
COPY --from=uv /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /app/api
COPY api/pyproject.toml api/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# -----------------------------------------------------------------------------
# Web app build, only pulled in by the `full` target
# -----------------------------------------------------------------------------
FROM node:24-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# -----------------------------------------------------------------------------
# Shared runtime: slim Python, the venv, the app code, a non-root user
# -----------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app --no-create-home app
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080
WORKDIR /app/api
COPY --from=deps /opt/venv /opt/venv
COPY api/app ./app
# SQLite lands here in development; production uses DATABASE_URL instead.
RUN mkdir -p /app/api/data && chown app:app /app/api/data
USER app
EXPOSE 8080
# The API rejects unknown Host headers, so the check sends the configured public host.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import os, urllib.parse as p, urllib.request as r; host = p.urlparse(os.environ.get('PUBLIC_ORIGIN') or 'http://localhost').hostname; r.urlopen(r.Request('http://127.0.0.1:' + os.environ.get('PORT', '8080') + '/api/health', headers={'Host': host}), timeout=4)"]
CMD ["sh", "-c", "exec uvicorn app.main:app_from_env --factory --host 0.0.0.0 --port \"${PORT:-8080}\" --proxy-headers --forwarded-allow-ips='*'"]

# -----------------------------------------------------------------------------
# full: the API also serves the built web app from STATIC_DIR (docker-compose)
# -----------------------------------------------------------------------------
FROM runtime AS full
COPY --from=web /app/web/dist /app/web/dist
ENV STATIC_DIR=/app/web/dist

# -----------------------------------------------------------------------------
# api: the default target, API only
# -----------------------------------------------------------------------------
FROM runtime AS api
