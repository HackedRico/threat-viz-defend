import logging
from dataclasses import dataclass
from typing import Protocol

import openai
from sqlalchemy.orm import Session

from app.analysis.analyst import Analyst, LlmAnalyst
from app.config import Settings
from app.db import Database, utcnow
from app.errors import bad_request
from app.llm.backboard import BackboardLlm
from app.llm.base import JsonMode, Llm, LlmError
from app.llm.openai_compat import OpenAICompatibleLlm
from app.providers.netguard import Resolver, check_base_url, resolve
from app.providers.secrets_box import SecretBox
from app.schemas import ProviderIn, ProviderOut, ProviderTestOut
from app.tables import ProviderRow

# =============================================================================
# Module Overview
# =============================================================================
# Which model analyzes a user's boards. A user may save their own provider:
# an OpenAI-compatible endpoint or Backboard, with a base URL, a model and a
# key. `Providers.for_user` returns that user's analyst, or the server's default
# when they saved none. `AnalystSource` is the seam boards and the quiz use,
# so tests and other deployments can pick analysts any other way.

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Chosen:
    """The analyst for one request, and whether it spends the user's own key rather than the server's."""

    analyst: Analyst
    own_key: bool


class AnalystSource(Protocol):
    """Anything that picks the analyst for a user."""

    def for_user(self, user_id: str) -> Chosen:
        """The analyst that should serve `user_id` right now."""
        ...


class FixedAnalyst:
    """An `AnalystSource` that gives everyone the same analyst, as tests and single-model setups want."""

    def __init__(self, analyst: Analyst) -> None:
        self._analyst = analyst

    def for_user(self, user_id: str) -> Chosen:
        """The one analyst, on the server's budget."""
        return Chosen(self._analyst, own_key=False)


class Providers:
    """Saved per-user providers, with the server's analyst as the fallback."""

    def __init__(
        self,
        db: Database,
        settings: Settings,
        server: Analyst,
        *,
        demo: bool,
        resolver: Resolver = resolve,
    ) -> None:
        self._db = db
        self._settings = settings
        self._server = server
        self._demo = demo
        self._box = SecretBox(settings.app_secret)
        self._resolver = resolver

    def for_user(self, user_id: str) -> Chosen:
        """The user's own analyst when they saved a provider, otherwise the server's."""
        with self._db.session() as session:
            row = session.get(ProviderRow, user_id)
            if row is None:
                return Chosen(self._server, own_key=False)
            kind, base_url, model, sealed, memory, assistant = (
                row.kind,
                row.base_url,
                row.model,
                row.key_sealed,
                row.memory,
                row.assistant_id,
            )
        # Checked again at use, because DNS for a saved host can change after it was saved.
        url = check_base_url(
            base_url, allow_private=self._settings.allow_private_provider_urls, resolver=self._resolver
        )
        try:
            key = self._box.open(sealed, user_id)
        except ValueError as exc:
            raise bad_request(str(exc)) from exc
        llm = self._build(kind, url, model, key, memory, assistant, user_id)
        return Chosen(LlmAnalyst(llm), own_key=True)

    def view(self, session: Session, user_id: str) -> ProviderOut:
        """What analyzes this user's boards, without the key."""
        row = session.get(ProviderRow, user_id)
        if row is not None:
            return ProviderOut(
                source="custom",
                kind=row.kind,
                base_url=row.base_url,
                model=row.model,
                key_preview=f"...{row.key_last4}" if row.key_last4 else None,
                memory=row.memory,
                label=_label(row.kind, row.model, row.memory),
                updated_at=row.updated_at,
            )
        return ProviderOut(
            source="demo" if self._demo else "server",
            kind=None,
            base_url=None,
            model=None,
            key_preview=None,
            memory=False,
            label=self._server.label,
            updated_at=None,
        )

    def save(self, session: Session, user_id: str, body: ProviderIn) -> ProviderOut:
        """Save the user's provider, keeping the stored key when `api_key` is null."""
        url = check_base_url(
            body.base_url, allow_private=self._settings.allow_private_provider_urls, resolver=self._resolver
        )
        _check_model(body)
        row = session.get(ProviderRow, user_id)
        _key_stays_home(row, body, url)
        new_key = body.api_key
        if new_key is None and row is None:
            if body.kind == "backboard":
                raise bad_request("Enter your Backboard API key.")
            # Local servers such as Ollama take no key; an empty one is stored so the row stays complete.
            new_key = ""
        if row is None:
            row = ProviderRow(user_id=user_id)
            session.add(row)
        if new_key is not None:
            key = new_key.strip()
            row.key_sealed = self._box.seal(key, user_id)
            row.key_last4 = key[-4:]
        # A different Backboard account or kind would not know the old assistant.
        if row.kind != body.kind or row.base_url != url:
            row.assistant_id = None
        row.kind, row.base_url, row.model, row.memory = body.kind, url, body.model.strip(), body.memory
        row.updated_at = utcnow()
        session.flush()
        return self.view(session, user_id)

    def delete(self, session: Session, user_id: str) -> None:
        """Forget the user's provider and key; the server's default takes over."""
        row = session.get(ProviderRow, user_id)
        if row is not None:
            session.delete(row)

    def test(self, user_id: str, body: ProviderIn) -> ProviderTestOut:
        """Check a provider before saving: the host is allowed, the key works, and which models it offers."""
        url = check_base_url(
            body.base_url, allow_private=self._settings.allow_private_provider_urls, resolver=self._resolver
        )
        _check_model(body)
        key = body.api_key
        if key is None:
            with self._db.session() as session:
                row = session.get(ProviderRow, user_id)
                _key_stays_home(row, body, url)
                if row is None and body.kind == "backboard":
                    raise bad_request("Enter your Backboard API key to test.")
                try:
                    key = self._box.open(row.key_sealed, user_id) if row is not None else ""
                except ValueError as exc:
                    raise bad_request(str(exc)) from exc
        label = _label(body.kind, body.model, body.memory)
        try:
            if body.kind == "backboard":
                llm = BackboardLlm(api_key=key, model=body.model, base_url=url, memory=body.memory, timeout_s=15)
                return ProviderTestOut(ok=True, label=label, message=llm.check(), models=[])
            models = _list_models(url, key)
        except LlmError as exc:
            return ProviderTestOut(ok=False, label=label, message=exc.message, models=[])
        found = body.model in models if models else True
        message = (
            "Connected." if found else f"Connected, but the endpoint does not list {body.model}. Check the model name."
        )
        return ProviderTestOut(ok=found, label=label, message=message, models=models[:200])

    def _build(
        self, kind: str, url: str, model: str, key: str, memory: bool, assistant: str | None, user_id: str
    ) -> Llm:
        """The adapter for a saved provider."""
        if kind == "backboard":

            def remember(assistant_id: str) -> None:
                with self._db.session() as session:
                    row = session.get(ProviderRow, user_id)
                    if row is not None:
                        row.assistant_id = assistant_id

            return BackboardLlm(
                api_key=key,
                model=model,
                base_url=url,
                memory=memory,
                assistant_id=assistant,
                on_assistant=remember,
                timeout_s=self._settings.llm_timeout_s,
            )
        # Most user endpoints are not OpenAI itself, so ask for JSON in the prompt unless it is.
        mode: JsonMode = "json_schema" if "api.openai.com" in url else "prompt"
        # The SDK insists on some key; servers that need none ignore it.
        return OpenAICompatibleLlm(
            model=model, api_key=key or "none", base_url=url, json_mode=mode, timeout_s=self._settings.llm_timeout_s
        )


def _key_stays_home(row: ProviderRow | None, body: ProviderIn, url: str) -> None:
    """Refuse to reuse a saved key for another host: whoever holds the session could otherwise send it anywhere."""
    if body.api_key is None and row is not None and (row.base_url != url or row.kind != body.kind):
        raise bad_request("Enter the API key again when you change the provider or its base URL.")


def _check_model(body: ProviderIn) -> None:
    """Reject a Backboard model that is not written as `provider/model`."""
    if body.kind == "backboard" and "/" not in body.model.strip("/"):
        raise bad_request("Write the Backboard model as provider/model, such as openai/gpt-4o.")


def _label(kind: str, model: str, memory: bool) -> str:
    """How a saved provider is named in the app."""
    if kind == "backboard":
        return f"{model} via Backboard" + (" with memory" if memory else "")
    return f"{model} (your provider)"


def _list_models(url: str, key: str) -> list[str]:
    """Model ids an OpenAI-compatible endpoint lists, as proof the key works."""
    client = openai.OpenAI(
        api_key=key or "none",
        base_url=url,
        timeout=10.0,
        max_retries=0,
        http_client=openai.DefaultHttpxClient(follow_redirects=False),
    )
    try:
        return sorted(model.id for model in client.models.list())
    except (openai.AuthenticationError, openai.PermissionDeniedError) as exc:
        raise LlmError("auth", "The provider rejected the API key.") from exc
    except openai.NotFoundError:
        # Some compatible servers do not implement /models; a working key is all we can check there.
        return []
    except (openai.APIConnectionError, openai.APITimeoutError) as exc:
        raise LlmError("unavailable", "The provider could not be reached at that base URL.") from exc
    except openai.APIStatusError as exc:
        raise LlmError("unavailable", f"The provider answered {exc.status_code}.") from exc
