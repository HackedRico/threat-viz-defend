# Conventions

How code, tests, docs and commits look in this repo. Match the file you are in first; these rules settle anything it does not.

## Every file

- Opens with a Module Overview banner right after its imports: two to four lines on what the module does and its key names in backticks.
- Every exported function, class and constant has a one-line doc comment that says what it returns or does.
- Comments say why, never what: a constraint, a trade-off, a fact from elsewhere the reader needs. No commented-out code and no TODO without an owner.
- Plain ASCII: straight quotes, and a hyphen only inside compound words. Never an em dash or en dash, in code, comments, docs, UI copy, commits or PRs.
- Names say the domain: `board`, `map`, `flow`, `threat`, `crossing`, `exposure`. Verbs for functions, nouns for data.

## Python (`api/`, `integrations/`, `scripts/`)

- Python 3.12, managed with uv. `uv run ruff check .`, `uv run ruff format --check .` and `uv run mypy` pass with no ignores added to hide a real problem.
- Type every signature. Use `X | None`, built-in generics and PEP 695 type parameters (`def f[T: BaseModel](...)`).
- Validate at the top of a function, then do the work. Raise through `api/app/errors.py` (`bad_request`, `not_found`, `conflict`, `too_many`) with a message that tells the user what to do next, and name a setting in backticks.
- Pure logic goes in `api/app/domain/` and takes plain values, so it is tested without a database or network. Anything with I/O takes its dependencies as arguments (`Database`, `Analyst`, `Jobs`, `Budget`) so tests pass fakes.
- Pydantic models for every shape that crosses a boundary. Shapes a model fills subclass `ModelOutput`; request bodies subclass `RequestBody`.
- Every regex that reads untrusted text has an upper bound on each repeat. A new pattern gets a timing test on hostile input in `api/tests/test_masking.py`.
- Log with `logging.getLogger(__name__)` and a `[area]` prefix. Never log a key, a password, uploaded content or a model reply.

## TypeScript and React (`web/`)

- TypeScript strict, `npm run typecheck`, `npm test` and `npm run build` pass. No `any` outside an SDK boundary, and that one carries a comment.
- API shapes come only from the generated `web/src/api/schema.d.ts`, aliased once in `web/src/api/types.ts`. Calls go through `api` in `web/src/api/client.ts`.
- Components are small. Logic without React goes in a `.ts` module with a `node:test` file beside it (`layout.test.ts` next to `layout.ts`), and imports use the `.ts` extension.
- Each component keeps its CSS in a file beside it. Colors, fonts, radii, spacing and shadows come from `web/src/styles/tokens.css`, which defines light and dark. No hard-coded colors.
- Model text renders as React text. Never `dangerouslySetInnerHTML`, never Markdown to HTML.
- Accessible by default: every control has a label, every map element is focusable, color is never the only signal, and motion respects `prefers-reduced-motion`.
- zustand stores return stable values from selectors: select the stored value, derive arrays and objects in the component.

## Tests

- A bug fix starts with a test that fails on the bug. A feature adds tests of its behavior through its public interface.
- Tests never call a real model, voice service or the internet. Use `DemoAnalyst`, scripted fakes, `InlineJobs`, `httpx.MockTransport`, and the `make_client` fixture in `api/tests/conftest.py`.
- Test names say the behavior: `test_a_saved_key_is_not_reused_for_another_host`.

## Docs

- Sentence case headings, plain words, active voice, short sentences.
- A behavior change updates its doc in the same PR: [user-guide.md](user-guide.md) for screens, [api.md](api.md) for endpoints, [security.md](security.md) for controls, `.env.example` and [deploy.md](deploy.md) for settings, and the area's `AGENTS.md` when how to work in it changes.
- Documents for coding agents (`AGENTS.md` files) hold what an agent cannot find by reading the code: the reason for a rule, the order of steps, the gotcha. They point at files rather than repeating them.

## Commits and pull requests

- Conventional Commits: `type(scope): description`, lowercase, present tense, no trailing period. Types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `chore`. Scopes: `api`, `web`, `voice`, `diagrams`, `integrations`, `deploy`, `docs`.
- Commit as each piece works, not once at the end. The body says why, in a sentence or two.
- No AI attribution lines in commits or PRs.
- Never push to `main`. Open a PR from your branch with what changed, why, how to check it, and any risk.
