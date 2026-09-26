# Hosting

The spoke that puts the app on the internet and holds the platform accounts. Owner: Jonathan. It touches the core engine at one seam: the settings `api/app/config.py` reads, and `/api/health` coming back ([docs/team.md](../docs/team.md)). The step by step runbook, including DNS and teardown, is [docs/deploy.md](../docs/deploy.md); this guide is how to change the hosting safely. The root [AGENTS.md](../AGENTS.md) holds the rules that apply everywhere.

## What runs where

| Piece | Where | Defined in |
|---|---|---|
| API | DigitalOcean App Platform service, built from the root `Dockerfile` (`api` target), port 8080 | `.do/app.yaml` |
| Web app | App Platform static site built from `web/` with `VITE_API_BASE_URL` set at build time | `.do/app.yaml` |
| Database | App Platform dev Postgres, injected as `DATABASE_URL` | `.do/app.yaml` |
| Domains | `api.<domain>` and `app.<domain>` as CNAMEs at GoDaddy pointing at App Platform | `.do/app.yaml` `domains`, and GoDaddy DNS |
| CI | GitHub Actions: lint, types, tests, OpenAPI freshness, Docker builds | `.github/workflows/ci.yml` |
| Local production-like run | Postgres plus the `full` image serving API and web on one origin | `docker-compose.yml` |

## Rules for this area

- **Secrets never enter the repo.** In `.do/app.yaml`, a secret has `type: SECRET`, `scope: RUN_TIME` and no value; set its value in the App Platform console. The repo is public.
- **Settings have one source.** Every variable is read and validated in `api/app/config.py`. A new variable is added there by Ricky, and you document it in `.env.example` and `docs/deploy.md` in the same PR. Production refuses to start without `PUBLIC_ORIGIN` (the API's own https origin), `APP_SECRET` (32+ characters) and `INVITE_CODES` (6+ characters each), and with `DEV_USERNAME` set; read the startup error, it names the variable.
- **App Platform disks are wiped on every deploy.** Keep `DATABASE_URL` pointed at Postgres there, never SQLite.
- **Split hosting needs matching settings.** `CORS_ORIGINS` on the API must list the web app's exact origin, and the static site's `VITE_API_BASE_URL` must be the API's origin. Keep both on one registrable domain (`app.` and `api.`) so the session cookie stays same-site.
- **The image defaults to production.** `APP_ENV=production` is set in the `Dockerfile`; local runs get development from `.env`.
- `TRUST_PROXY=true` only behind App Platform, which sets `do-connecting-ip`; anywhere else a client could choose its own IP for rate limits.

## Checking a change

```bash
python3 -c "import yaml, sys; yaml.safe_load(open('.do/app.yaml'))"   # syntax
doctl apps spec validate .do/app.yaml                                  # App Platform's own check
docker build -t threatviz-api .                                        # optional locally; CI builds it too
```

After a deploy: `curl https://api.<domain>/api/health` answers `{"ok":true}`, `curl https://api.<domain>/api/config` shows the expected `analyst` and `voice_enabled`, and signing in on `https://app.<domain>` works in a private window.

## Accounts and credits

You hold the DigitalOcean, GoDaddy, ElevenLabs, Backboard and Snowflake accounts. Hand a teammate a key directly for their local `.env`; never paste one into a PR, issue or chat. Keep a list of every key issued so teardown in [docs/deploy.md](../docs/deploy.md) can revoke them all.

## Adding a platform such as Snowflake

Nothing uses Snowflake yet. Before building, pick its seam with Ricky, as [docs/team.md](../docs/team.md) describes. A model service becomes a provider adapter in `api/app/llm/`; a data service becomes a module that reads the tables and never uploaded content. Its keys arrive as new settings in `api/app/config.py`, and its hosting pieces land here.
