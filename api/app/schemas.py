from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.domain.models import SystemMap, ThreatAnalysis
from app.domain.quiz import Mastery, QuestionKind, QuestionTopic, QuizEvidence, QuizOption, Result
from app.voice import AudioType

# =============================================================================
# Module Overview
# =============================================================================
# The HTTP contract: every request and response body the API speaks. The web
# app's TypeScript types are generated from the OpenAPI schema these classes
# produce (`npm run gen:api` in `web/`), so a change here reaches the browser
# through a regenerated `web/src/api/schema.d.ts`, never by hand.

BoardStatus = Literal["empty", "mapping", "review", "analyzing", "ready"]
SourceKind = Literal["text", "file", "code", "agent", "github", "example"]


class RequestBody(BaseModel):
    """Base for request bodies: unknown keys are rejected so typos fail loudly."""

    model_config = ConfigDict(extra="forbid")


# =============================================================================
# Accounts
# =============================================================================


class SignupIn(RequestBody):
    """Create an account with the event's invite code."""

    username: str = Field(min_length=3, max_length=24)
    password: str = Field(min_length=10, max_length=128)
    invite_code: str = Field(min_length=1, max_length=64)
    # A field real users never see or fill; bots that fill every input give themselves away.
    website: str = Field(default="", max_length=200)


class LoginIn(RequestBody):
    """Sign in."""

    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class UserOut(BaseModel):
    """The signed-in user."""

    id: str
    username: str
    created_at: datetime


class UsageOut(BaseModel):
    """What the user has spent today against their daily allowance."""

    model_calls_today: int
    model_calls_limit: int
    voice_sessions_today: int
    voice_sessions_limit: int
    dictations_today: int
    dictations_limit: int


class MeOut(BaseModel):
    """The signed-in user and their usage."""

    user: UserOut
    usage: UsageOut


# =============================================================================
# App configuration
# =============================================================================


class FilePolicyOut(BaseModel):
    """Which files the browser skips before upload, and the size caps."""

    model_config = ConfigDict(populate_by_name=True)

    secret_names: list[str] = Field(alias="secretNames")
    secret_extensions: list[str] = Field(alias="secretExtensions")
    safe_env_suffixes: list[str] = Field(alias="safeEnvSuffixes")
    secret_words_pattern: str = Field(alias="secretWordsPattern")
    config_extensions: list[str] = Field(alias="configExtensions")
    ignored_dirs: list[str] = Field(alias="ignoredDirs")
    lockfiles: list[str]
    binary_extensions: list[str] = Field(alias="binaryExtensions")
    max_file_bytes: int = Field(alias="maxFileBytes")
    max_upload_bytes: int = Field(alias="maxUploadBytes")
    max_files: int = Field(alias="maxFiles")
    secret_paths: list[str] = Field(alias="secretPaths")


class ConfigOut(BaseModel):
    """Public facts about this deployment, readable before signing in."""

    app_name: str
    analyst: str
    demo_mode: bool
    voice_enabled: bool
    dictation_enabled: bool
    signup_open: bool
    file_policy: FilePolicyOut


class HealthOut(BaseModel):
    """Liveness."""

    ok: bool


# =============================================================================
# Boards
# =============================================================================


class SeverityCounts(BaseModel):
    """Threats per severity."""

    critical: int
    high: int
    medium: int
    low: int


class BoardSummary(BaseModel):
    """A board as listed in the sidebar."""

    id: str
    title: str
    status: BoardStatus
    example: bool
    updated_at: datetime
    revision: int
    counts: SeverityCounts


class SourceOut(BaseModel):
    """Material added to a board. Only its name and size are kept, never its content."""

    id: str
    name: str
    kind: SourceKind
    bytes: int
    added_at: datetime


class EventOut(BaseModel):
    """A line in a board's activity log."""

    id: int
    kind: str
    text: str
    created_at: datetime


class ExposureOut(BaseModel):
    """What reaches one AI component and where its output can go, from the rules."""

    node: str
    private_data: list[str]
    untrusted: list[str]
    outbound: list[str]
    lethal: bool


class BoardOut(BaseModel):
    """A board with everything the canvas needs."""

    id: str
    title: str
    status: BoardStatus
    example: bool
    sources: list[SourceOut]
    map: SystemMap | None
    previous_map: SystemMap | None
    analysis: ThreatAnalysis | None
    analysis_version: int
    analyzed_by: str | None
    error: str | None
    revision: int
    created_at: datetime
    updated_at: datetime
    events: list[EventOut]
    # Worked out by the rules, so the browser never reimplements them.
    exposure: list[ExposureOut]
    crossings: list[str]
    counts: SeverityCounts


class BoardCreate(RequestBody):
    """Start an empty board."""

    title: str = Field(min_length=1, max_length=120)


class BoardPatch(RequestBody):
    """Rename a board."""

    title: str = Field(min_length=1, max_length=120)


class SourceIn(RequestBody):
    """One piece of material: pasted text or a file read as text in the browser."""

    name: str = Field(min_length=1, max_length=300)
    kind: Literal["text", "file", "code"]
    text: str = Field(max_length=200_000)


class SourcesIn(RequestBody):
    """Material to draw or update the map from."""

    sources: list[SourceIn] = Field(min_length=1, max_length=400)


class GithubIn(RequestBody):
    """A public GitHub repository to read."""

    url: str = Field(min_length=10, max_length=300)


class MapIn(RequestBody):
    """A map edited by hand."""

    map: SystemMap


class AskIn(RequestBody):
    """A question about a finished board."""

    question: str = Field(min_length=1, max_length=2_000)
    focus: str | None = Field(default=None, max_length=80)


class MemoryUse(BaseModel):
    """What Backboard memory did around one model call: the notes it fed in, and whether it keeps a new one."""

    recalled: list[str]
    kept: bool


class AskOut(BaseModel):
    """The answer to a question, the ids to highlight, and how memory took part. `memory` is null when it is off."""

    answer: str
    highlight: list[str]
    memory: MemoryUse | None


# =============================================================================
# Quiz
# =============================================================================


class QuestionOut(BaseModel):
    """A question as the browser sees it before answering: no key, no explanation."""

    id: str
    topic: QuestionTopic
    kind: QuestionKind
    prompt: str
    options: list[QuizOption]


class AttemptOut(BaseModel):
    """The result of answering one question, with everything that explains it."""

    question_id: str
    result: Result
    feedback: str
    explanation: str
    evidence: list[QuizEvidence]
    highlight: list[str]
    # The right option ids, shown once the question is answered; empty for open questions.
    correct_ids: list[str]
    your_ids: list[str]
    your_text: str | None


class QuizFocus(BaseModel):
    """Topics Backboard memory says the developer found hard before, which the quiz asks first, and why."""

    topics: list[QuestionTopic]
    notes: list[str]


class QuizOut(BaseModel):
    """The quiz for a board's current analysis, and the latest result per question."""

    analysis_version: int
    questions: list[QuestionOut]
    results: dict[str, AttemptOut]
    mastery: Mastery
    # Null when memory is off or remembers no weak topic that this quiz covers.
    focus: QuizFocus | None


class AnswerIn(RequestBody):
    """An answer: option ids for choice questions, words for open ones."""

    question_id: str = Field(min_length=1, max_length=80)
    choice_ids: list[str] = Field(default_factory=list, max_length=10)
    text: str | None = Field(default=None, max_length=3_000)


class AnsweredOut(BaseModel):
    """The graded attempt, the mastery that follows from it, and how memory took part. `memory` is null when off."""

    attempt: AttemptOut
    mastery: Mastery
    memory: MemoryUse | None


# =============================================================================
# Voice
# =============================================================================


class VoiceSessionOut(BaseModel):
    """What the browser needs to start a private ElevenLabs conversation."""

    conversation_token: str
    dynamic_variables: dict[str, str]


class BriefOut(BaseModel):
    """A spoken-style walkthrough of a board."""

    text: str


class DictationIn(RequestBody):
    """A short recording of a spoken question, base64 encoded because every write is JSON."""

    # About 1,500,000 bytes of audio, which keeps the body under the request cap.
    audio: str = Field(min_length=1, max_length=2_000_000)
    audio_type: AudioType


class DictationOut(BaseModel):
    """What was said, for the user to check before sending."""

    text: str


# =============================================================================
# Personal tokens and coding agents
# =============================================================================


class TokenCreate(RequestBody):
    """Name a new personal token."""

    name: str = Field(min_length=1, max_length=60)


class TokenOut(BaseModel):
    """A personal token, without its secret."""

    id: str
    name: str
    prefix: str
    created_at: datetime
    last_used_at: datetime | None


class TokenCreated(BaseModel):
    """A new token. `token` is shown this once and never again."""

    token: str
    info: TokenOut


class AgentChangeIn(RequestBody):
    """A change a coding agent made, sent by a hook or the MCP server."""

    agent: str = Field(default="Coding agent", min_length=1, max_length=40)
    summary: str = Field(default="", max_length=4_000)
    diff: str = Field(default="", max_length=200_000)
    files: list[Annotated[str, Field(max_length=1_000)]] = Field(default_factory=list, max_length=500)


class AgentChangeOut(BaseModel):
    """Where the change went."""

    board_id: str
    status: BoardStatus
    review_url: str


# =============================================================================
# Model provider
# =============================================================================

# The model is always a Chat Completions endpoint; Backboard is memory, set under `/api/memory`, never the model.
ProviderKind = Literal["openai_compatible"]


class ProviderIn(RequestBody):
    """A user's own model provider. `api_key` null keeps the saved key."""

    kind: ProviderKind = "openai_compatible"
    base_url: str = Field(min_length=8, max_length=300)
    model: str = Field(min_length=1, max_length=120)
    api_key: str | None = Field(default=None, min_length=1, max_length=500)


class ProviderOut(BaseModel):
    """Which model analyzes the user's boards. Keys are never returned, only their last four characters."""

    source: Literal["custom", "server", "demo"]
    kind: ProviderKind | None
    base_url: str | None
    model: str | None
    key_preview: str | None
    label: str
    updated_at: datetime | None


class ProviderTestOut(BaseModel):
    """Whether a provider answered, and the models it offers when it lists them."""

    ok: bool
    label: str
    message: str
    models: list[str]


# =============================================================================
# Memory
# =============================================================================


MemorySource = Literal["own", "server", "none"]


class MemoryIn(RequestBody):
    """A user's own Backboard key for memory, used in place of the server's. `api_key` null keeps the saved key."""

    api_key: str | None = Field(default=None, min_length=1, max_length=500)


class MemorySwitchIn(RequestBody):
    """Turn memory on or off for this user."""

    enabled: bool


class MemoryOut(BaseModel):
    """The user's memory: switched on or not, whether it works now, and whose Backboard account holds it. No key."""

    enabled: bool
    active: bool
    # `own` is the user's saved key, `server` is `BACKBOARD_API_KEY`, `none` means no key anywhere.
    source: MemorySource
    saved: bool
    key_preview: str | None
    message: str
    updated_at: datetime | None


class MemoryNoteOut(BaseModel):
    """One note Backboard holds about the user."""

    id: str
    content: str
    # As Backboard sent it, an ISO timestamp when it sent one.
    created_at: str | None


class MemoryNotesOut(BaseModel):
    """What Backboard remembers about the user, newest first."""

    source: MemorySource
    notes: list[MemoryNoteOut]


class MemoryTestOut(BaseModel):
    """Whether Backboard accepted the key."""

    ok: bool
    message: str
