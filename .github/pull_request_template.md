## What changes

<!-- One or two sentences in plain words. -->

## Why

<!-- The problem this solves. Link the issue it closes, such as "Closes #12", or drop this line. -->

## How to check it

<!-- Steps a reviewer can follow: the commands to run, the screen to open, what to look for. -->

## Risk

<!-- What could break. Say so if this changes what is stored, or what reaches a model or another service. Write "None known" if nothing. -->

## Checklist

- [ ] `uv run pytest`, `uv run ruff check .`, `uv run ruff format --check .` and `uv run mypy` pass in `api/`
- [ ] `npm run typecheck`, `npm test` and `npm run build` pass in `web/`
- [ ] `npm run gen:api` ran, if `api/app/schemas.py`, `api/app/domain/models.py` or a route changed
- [ ] The doc that describes the changed behavior is updated
- [ ] No rule in `docs/security.md` is weakened, and no key, `.env` or database is committed
- [ ] A change to a seam or another owner's folder in `docs/team.md` names that owner as a reviewer
