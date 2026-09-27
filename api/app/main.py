import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.convertors import PathConvertor, register_url_convertor
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.cors import CORSMiddleware

from app.analysis.analyst import Analyst, DemoAnalyst, LlmAnalyst
from app.auth.service import Accounts, Tokens
from app.boards.service import Boards
from app.config import Settings, load_settings
from app.context import Services
from app.db import Database
from app.errors import AppError, ErrorResponse
from app.examples import load_examples
from app.jobs import Jobs, ThreadJobs
from app.limits import Budget, RateLimiter
from app.llm.openai_compat import OpenAICompatibleLlm
from app.mcp_tools import build_mcp
from app.providers.memory import MemorySettings
from app.providers.netguard import Resolver, resolve
from app.providers.service import Providers
from app.quiz_service import Quiz
from app.routes import agents, auth, boards, dictation, memory, meta, provider, quiz
from app.voice import ElevenLabsTranscriber, ElevenLabsVoice, Transcriber, VoiceClient
from app.web import RequestGuard, spa_file

_REPO_ROOT = Path(__file__).resolve().parents[2]

# =============================================================================
# Module Overview
# =============================================================================
# Builds the application. `create_app` wires settings, the database, the
# analyst, Backboard memory, jobs and the voice clients into `Services`, mounts
# the JSON routes, the MCP server at `/mcp` and the built web app, and renders
# every error in one shape. Tests call it with fakes; `app` is what uvicorn
# serves.

log = logging.getLogger(__name__)

_ERRORS: dict[int | str, dict[str, object]] = {
    status: {"model": ErrorResponse} for status in (400, 401, 403, 404, 409, 413, 415, 422, 429, 502, 503)
}


class _WebPath(PathConvertor):
    """Any path but `/mcp` and below, so a GET from an MCP client reaches the MCP app, not the web app."""

    regex = r"(?!mcp(?:/|$)).*"


register_url_convertor("web_path", _WebPath())


def create_app(
    settings: Settings,
    *,
    analyst: Analyst | None = None,
    jobs: Jobs | None = None,
    voice: VoiceClient | None = None,
    transcriber: Transcriber | None = None,
    resolver: Resolver = resolve,
    backboard: httpx.BaseTransport | None = None,
) -> FastAPI:
    """Build the API, the MCP server and the web app for `settings`; fakes may replace any service."""
    load_examples()  # fail at startup, not on first use, if an example is broken
    db = Database(settings.database_url)
    limiter = RateLimiter()
    budget = Budget(settings, limiter)
    chosen_analyst = analyst or _analyst_for(settings)
    job_runner = jobs or ThreadJobs()
    memories = MemorySettings(db, settings, transport=backboard)
    providers = Providers(
        db,
        settings,
        chosen_analyst,
        demo=isinstance(chosen_analyst, DemoAnalyst),
        resolver=resolver,
    )
    board_service = Boards(db, providers, budget, job_runner, memories)
    services = Services(
        settings=settings,
        db=db,
        limiter=limiter,
        budget=budget,
        analyst=chosen_analyst,
        jobs=job_runner,
        accounts=Accounts(settings, limiter),
        tokens=Tokens(limiter),
        boards=board_service,
        quiz=Quiz(db, board_service, providers, budget, memories),
        providers=providers,
        memory=memories,
        voice=voice if voice is not None else _voice_for(settings),
        transcriber=transcriber if transcriber is not None else _transcriber_for(settings),
    )
    mcp, mcp_app = build_mcp(services)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        db.create_tables()
        _seed_dev_account(services)
        recovered = board_service.recover_interrupted()
        if recovered:
            log.warning("[startup] Reset %d boards left busy by a restart.", recovered)
        log.info(
            "[startup] %s ready; analyst: %s; memory: %s; voice: %s; dictation: %s.",
            settings.app_name,
            chosen_analyst.label,
            "Backboard" if memories.server_key_set else "only for users who add a Backboard key",
            services.voice is not None,
            services.transcriber is not None,
        )
        # A mounted app's own lifespan never runs, so the MCP session manager starts here.
        async with mcp.session_manager.run():
            yield
        if isinstance(job_runner, ThreadJobs):
            job_runner.shutdown()

    app = FastAPI(
        title=f"{settings.app_name} API",
        version="1.0.0",
        lifespan=lifespan,
        responses=_ERRORS,
        docs_url=None if settings.production else "/api/docs",
        redoc_url=None,
        openapi_url=None if settings.production else "/api/openapi.json",
    )
    app.state.services = services
    _add_error_handlers(app)
    for module in (meta, auth, boards, quiz, dictation, provider, memory, agents):
        app.include_router(module.router)

    static_dir = settings.static_dir
    if static_dir is not None:

        @app.get("/{path:web_path}", include_in_schema=False)
        def web_app(path: str) -> Response:
            """Serve the built web app, sending client-side routes to `index.html`."""
            if path.startswith("api/"):
                raise AppError(404, "not_found", "No such endpoint.")
            found = spa_file(static_dir, path)
            if found is None:
                raise AppError(404, "not_found", "The web app is not built. Run `npm run build` in `web/`.")
            immutable = found.parent.name == "assets"
            cache = "public, max-age=31536000, immutable" if immutable else "no-cache"
            return FileResponse(found, headers={"Cache-Control": cache})

    # The MCP app matches every path, so it goes last; its own route is exactly `/mcp`.
    app.mount("/", mcp_app)
    app.add_middleware(RequestGuard, settings=settings)
    if settings.cors_origins:
        # Only listed frontend origins may send the session cookie cross-origin; `*` is never used.
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
            allow_headers=["Content-Type"],
            max_age=600,
        )
    return app


def _seed_dev_account(services: Services) -> None:
    """Create the development account from `DEV_USERNAME` and `DEV_PASSWORD`, with the example board."""
    settings = services.settings
    if settings.production or not settings.dev_username or not settings.dev_password:
        return
    with services.db.session() as session:
        user = services.accounts.ensure_account(session, settings.dev_username, settings.dev_password)
        if not services.boards.all_for(session, user.id):
            services.boards.add_example(session, user.id)
    log.info("[startup] Development account %r is ready; sign in with DEV_PASSWORD from .env.", settings.dev_username)


def _analyst_for(settings: Settings) -> Analyst:
    """The model-backed analyst when a model is configured, otherwise the demo analyst."""
    if not settings.llm_configured:
        log.warning("[startup] No `LLM_API_KEY` and `LLM_MODEL`; running in demo mode with the built-in example only.")
        return DemoAnalyst()
    llm = OpenAICompatibleLlm(
        model=settings.llm_model or "",
        api_key=settings.llm_api_key or "",
        base_url=settings.llm_base_url,
        json_mode=settings.llm_json_mode,
        timeout_s=settings.llm_timeout_s,
        max_tokens=settings.llm_max_tokens,
    )
    return LlmAnalyst(llm)


def _voice_for(settings: Settings) -> VoiceClient | None:
    """The ElevenLabs client when voice is configured."""
    if not settings.voice_configured:
        return None
    return ElevenLabsVoice(settings.elevenlabs_api_key or "", settings.elevenlabs_agent_id or "")


def _transcriber_for(settings: Settings) -> Transcriber | None:
    """The ElevenLabs Speech to Text client when dictation is configured."""
    if not settings.dictation_configured:
        return None
    return ElevenLabsTranscriber(settings.elevenlabs_api_key or "", settings.elevenlabs_stt_model)


def _add_error_handlers(app: FastAPI) -> None:
    """Render every error as `{"error": {"code", "message"}}`."""

    @app.exception_handler(AppError)
    async def app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, exc.status, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def invalid(_: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        where = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
        message = f"{where}: {first.get('msg', 'invalid value')}" if where else "The request body is not valid."
        return JSONResponse({"error": {"code": "invalid_request", "message": message}}, 422)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "bad_request"}.get(exc.status_code, "bad_request")
        return JSONResponse({"error": {"code": code, "message": str(exc.detail)}}, exc.status_code)

    @app.exception_handler(Exception)
    async def unexpected(_: Request, exc: Exception) -> JSONResponse:
        log.exception("[http] Unhandled error", exc_info=exc)
        return JSONResponse(
            {"error": {"code": "internal_error", "message": "Something went wrong on our side. Try again."}}, 500
        )


def app_from_env() -> FastAPI:
    """The app configured from the process environment, for uvicorn's `--factory`."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    # Local runs read the repo-root `.env`; real environment variables still win, so hosts that
    # inject settings, such as App Platform, are unaffected.
    load_dotenv(_REPO_ROOT / ".env", override=False)
    return create_app(load_settings(os.environ))
