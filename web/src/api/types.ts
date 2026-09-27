import type { components } from "./schema";

// =============================================================================
// Module Overview
// =============================================================================
// Every shape the API speaks, named once. Each alias points at the schema that
// `npm run gen:api` generates from the server's OpenAPI document, so a change in
// `api/app/schemas.py` reaches every component through one regenerated file.

type Schemas = components["schemas"];

// ---------- map and threats ----------

/** What kind of element a node is on the data flow diagram. */
export type ElementKind = Schemas["Node"]["kind"];
/** A STRIDE category letter. */
export type Stride = Schemas["Threat"]["stride"];
/** A threat or attack path severity, most severe first. */
export type Severity = Schemas["Threat"]["severity"];

/** A trust boundary: a zone where everything runs with one level of trust. */
export type Boundary = Schemas["Boundary"];

/** An external entity, process or data store on the map. */
export type MapNode = Schemas["Node"];

/** A place in the material's code where a node is implemented. */
export type CodeRef = Schemas["CodeRef"];

/** Data moving from one node to another. */
export type Flow = Schemas["Flow"];

/** A data flow diagram of one system. */
export type SystemMap = Schemas["SystemMap"];

/** One threat, pinned to one node or flow. */
export type Threat = Schemas["Threat"];

/** A route an attacker takes from an entry point to an impact. */
export type AttackPath = Schemas["AttackPath"];

/** The threats and attack paths found on a confirmed map. */
export type ThreatAnalysis = Schemas["ThreatAnalysis"];

/** A reply to a question about a finished board, with how Backboard memory took part. */
export type Answer = Schemas["AskOut"];

/** What Backboard memory did around one model call: the notes it fed in, and whether it keeps a new one. */
export type MemoryUse = Schemas["MemoryUse"];

// ---------- accounts and config ----------

/** The signed-in user. */
export type UserOut = Schemas["UserOut"];

/** What the user has spent today against their daily allowance. */
export type UsageOut = Schemas["UsageOut"];

/** The signed-in user and their usage. */
export type MeOut = Schemas["MeOut"];

/** Sign up body; `website` is a honeypot that real users always send empty. */
export type SignupIn = Schemas["SignupIn"];

/** Sign in body. */
export type LoginIn = Schemas["LoginIn"];

/** Which files the browser skips before upload, and the size caps. Keys are camelCase on the wire. */
export type FilePolicy = Schemas["FilePolicyOut"];

/** Public facts about this deployment, readable before signing in. */
export type ConfigOut = Schemas["ConfigOut"];

// ---------- boards ----------

/** Where a board is in its life: empty, drawing, waiting for review, finding threats, done. */
export type BoardStatus = Schemas["BoardOut"]["status"];
/** Where a piece of material came from. */
export type SourceKind = Schemas["SourceOut"]["kind"];

/** Threats per severity. */
export type SeverityCounts = Schemas["SeverityCounts"];

/** A board as listed in the sidebar. */
export type BoardSummary = Schemas["BoardSummary"];

/** Material added to a board; only its name and size are kept. */
export type SourceOut = Schemas["SourceOut"];

/** A line in a board's activity log. */
export type EventOut = Schemas["EventOut"];

/** What reaches one AI component and where its output can go. */
export type ExposureOut = Schemas["ExposureOut"];

/** A board with everything the canvas needs. */
export type BoardOut = Schemas["BoardOut"];

/** One piece of material read as text in the browser. */
export type SourceIn = Schemas["SourceIn"];

// ---------- quiz ----------

/** What a quiz question is about. */
export type QuestionTopic = Schemas["QuestionOut"]["topic"];
/** How a question is answered: one option, several options, or own words. */
export type QuestionKind = Schemas["QuestionOut"]["kind"];
/** How an answer was graded. */
export type Result = Schemas["AttemptOut"]["result"];

/** One choice, keyed by the element id or STRIDE letter it stands for. */
export type QuizOption = Schemas["QuizOption"];

/** Where part of an answer comes from. */
export type QuizEvidence = Schemas["QuizEvidence"];

/** A question before answering: no key, no explanation. */
export type QuestionOut = Schemas["QuestionOut"];

/** The result of answering one question. */
export type AttemptOut = Schemas["AttemptOut"];

/** How much of the board the developer can defend right now. */
export type Mastery = Schemas["Mastery"];

/** The quiz for a board's current analysis and the latest result per question. */
export type QuizOut = Schemas["QuizOut"];

/** Topics memory says the developer found hard, which the quiz asks first. */
export type QuizFocus = Schemas["QuizFocus"];

/** An answer: option ids for choice questions, words for open ones. */
export type AnswerIn = Schemas["AnswerIn"];

/** The graded attempt and the mastery that follows. */
export type AnsweredOut = Schemas["AnsweredOut"];

// ---------- voice ----------

/** What the browser needs to start a private voice conversation. */
export type VoiceSessionOut = Schemas["VoiceSessionOut"];

/** A spoken-style walkthrough of a board. */
export type BriefOut = Schemas["BriefOut"];

/** A recorded question, base64 encoded, for the server to transcribe. */
export type DictationIn = Schemas["DictationIn"];

/** The recording formats the server accepts for dictation. */
export type AudioType = DictationIn["audio_type"];

/** The text of a dictated question. */
export type DictationOut = Schemas["DictationOut"];

// ---------- personal tokens ----------

/** A personal token, without its secret. */
export type TokenOut = Schemas["TokenOut"];

/** A new token; `token` is shown this once. */
export type TokenCreated = Schemas["TokenCreated"];

// ---------- model provider ----------

/** Which kind of model service a user brings. */
export type ProviderKind = Schemas["ProviderIn"]["kind"];

/** The model the user's analyses run on: their own, the server's default, or none (demo). */
export type ProviderOut = Schemas["ProviderOut"];

/** A provider to save or test; `api_key` null keeps the saved key. */
export type ProviderIn = Schemas["ProviderIn"];

/** The outcome of trying a provider, with the models it offers. */
export type ProviderTestOut = Schemas["ProviderTestOut"];

// ---------- memory ----------

/** The user's Backboard memory: on or off, working or not, and whose account holds it. */
export type MemoryOut = Schemas["MemoryOut"];

/** Whose Backboard account holds the user's memory: their own key, the server's, or none. */
export type MemorySource = MemoryOut["source"];

/** A Backboard key of the user's own to save or test; `api_key` null keeps the saved key. */
export type MemoryIn = Schemas["MemoryIn"];

/** Whether Backboard accepted a memory key. */
export type MemoryTestOut = Schemas["MemoryTestOut"];

/** One note Backboard holds about the user. */
export type MemoryNoteOut = Schemas["MemoryNoteOut"];

/** What Backboard remembers about the user, newest first. */
export type MemoryNotesOut = Schemas["MemoryNotesOut"];
