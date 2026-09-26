import { useCallback, useEffect, useRef, useState } from "react";
import {
  ConversationProvider,
  useConversationControls,
  useConversationMode,
  useConversationStatus,
  type Callbacks,
  type DisconnectionDetails,
} from "@elevenlabs/react";

import { api, ApiError, errorMessage } from "../api/client.ts";
import type { BoardOut, QuestionOut, SystemMap } from "../api/types.ts";
import { TOPIC_LABEL } from "../quiz/topics.ts";
import type { QuizState } from "../quiz/useQuiz.ts";
import { MicIcon } from "../shell/icons.tsx";
import { useSession } from "../shell/session.tsx";
import { optionLetter } from "./letters.ts";
import { useVoiceTools } from "./tools.ts";
import "./VoiceCoach.css";

// =============================================================================
// Module Overview
// =============================================================================
// The voice coach: a private ElevenLabs agent that quizzes the developer out
// loud. The server mints a one-conversation token and the browser starts a
// WebRTC session with it here; `useVoiceTools` in `tools.ts` registers the
// client tools the agent calls. This file owns the controls and transcript.

// The SDK's audio worklets are self-hosted (copied by `npm run copy:worklets`), since the CSP
// forbids the blob URLs it would otherwise build them from.
const WORKLETS = {
  rawAudioProcessor: "/vendor/elevenlabs/rawAudioProcessor.js",
  audioConcatProcessor: "/vendor/elevenlabs/audioConcatProcessor.js",
};

type MessagePayload = Parameters<NonNullable<Callbacks["onMessage"]>>[0];

interface Turn {
  id: number;
  role: "agent" | "user";
  text: string;
}

interface CoachProps {
  board: BoardOut;
  map: SystemMap;
  state: QuizState;
  active: string | null;
  onActive: (id: string) => void;
  onUseText: () => void;
}

/** The voice coach panel, with its own conversation provider. */
export function VoiceCoach(props: CoachProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const nextId = useRef(0);

  const onMessage = useCallback((payload: MessagePayload) => {
    const text = payload.message.trim();
    if (!text) return;
    nextId.current += 1;
    const turn: Turn = { id: nextId.current, role: payload.role === "agent" ? "agent" : "user", text };
    setTurns((before) => [...before.slice(-60), turn]);
  }, []);

  const onError = useCallback((message: string) => setProblem(message || "The voice session hit a problem."), []);
  const onDisconnect = useCallback((details: DisconnectionDetails) => {
    if (details.reason === "error") setProblem(details.message || "The voice session dropped.");
  }, []);

  return (
    <ConversationProvider onMessage={onMessage} onError={onError} onDisconnect={onDisconnect}>
      <Coach {...props} turns={turns} problem={problem} setProblem={setProblem} clearTurns={() => setTurns([])} />
    </ConversationProvider>
  );
}

// =============================================================================
// Session controls, transcript and client tools
// =============================================================================

function Coach({
  board,
  map,
  state,
  active,
  onActive,
  onUseText,
  turns,
  problem,
  setProblem,
  clearTurns,
}: CoachProps & { turns: Turn[]; problem: string | null; setProblem: (p: string | null) => void; clearTurns: () => void }) {
  const { refreshMe, me } = useSession();
  const { startSession, endSession, getInputVolume } = useConversationControls();
  const { status } = useConversationStatus();
  const { isSpeaking } = useConversationMode();
  const [starting, setStarting] = useState(false);
  const [micBlocked, setMicBlocked] = useState(false);
  const level = useRef<HTMLSpanElement>(null);
  const transcript = useRef<HTMLOListElement>(null);
  const live = status === "connected";

  useVoiceTools({ board, map, state, onActive });

  // End the call when the panel closes, so the microphone never stays open unseen.
  useEffect(() => () => endSession(), [endSession]);

  useEffect(() => {
    transcript.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [turns]);

  // Drive the mic ring from the input level; skipped entirely for reduced motion.
  useEffect(() => {
    if (!live || matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    let frame = 0;
    const tick = () => {
      const volume = Math.min(1, getInputVolume() * 4);
      level.current?.style.setProperty("--level", volume.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [live, getInputVolume]);

  const start = async () => {
    setProblem(null);
    setMicBlocked(false);
    setStarting(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setProblem("This browser cannot use a microphone here. Try a current Chrome, Edge, Firefox or Safari over https.");
        return;
      }
      // Ask for the mic first so a refusal is explained before a voice session is spent.
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach((track) => track.stop());
      } catch (caught) {
        const denied = caught instanceof DOMException && (caught.name === "NotAllowedError" || caught.name === "SecurityError");
        setMicBlocked(denied);
        setProblem(
          denied
            ? "Microphone access is blocked. Allow it in your browser's site settings, then start again."
            : "No microphone was found. Plug one in, or use the text quiz.",
        );
        return;
      }
      const session = await api.voiceSession(board.id);
      refreshMe();
      clearTurns();
      startSession({
        conversationToken: session.conversation_token,
        connectionType: "webrtc",
        dynamicVariables: session.dynamic_variables,
        workletPaths: WORKLETS,
      });
    } catch (caught) {
      const busy = caught instanceof ApiError && caught.status === 429;
      setProblem(busy ? `${errorMessage(caught)} The text quiz works meanwhile.` : errorMessage(caught));
    } finally {
      setStarting(false);
    }
  };

  const connecting = starting || status === "connecting";
  const quiz = state.quiz;
  const question = quiz?.questions.find((q) => q.id === active) ?? null;
  const questionIndex = quiz && question ? quiz.questions.indexOf(question) : -1;
  const remaining = me.usage.voice_sessions_limit - me.usage.voice_sessions_today;

  return (
    <div className="coach">
      <div className={`coach-stage ${live ? "is-live" : ""} ${isSpeaking ? "is-speaking" : ""}`}>
        <button
          type="button"
          className="coach-button"
          onClick={() => (live || status === "connecting" ? endSession() : void start())}
          disabled={starting}
          aria-describedby="coach-state"
        >
          <span className="coach-ring" ref={level} aria-hidden="true" />
          <MicIcon width={30} height={30} />
          <span className="coach-button-text">{live ? "Stop" : connecting ? "Connecting" : "Start talking"}</span>
        </button>
        <p id="coach-state" className="coach-state" role="status">
          {live
            ? isSpeaking
              ? "Coach is speaking. Listen, then answer out loud."
              : "Your mic is on. The coach is listening."
            : connecting
              ? "Connecting to the coach..."
              : "Mic is off. The coach asks each question out loud and grades what you say."}
        </p>
        {!live && !connecting && (
          <p className="field-hint">
            Your browser will ask for the microphone. {remaining > 0 ? `${remaining} voice session${remaining === 1 ? "" : "s"} left today.` : "No voice sessions left today."}
          </p>
        )}
      </div>

      {problem && (
        <div className="banner banner-error" role="alert">
          <div className="banner-body">
            {problem}
            {micBlocked && <span> Look for the microphone or lock icon in the address bar.</span>}
            <div className="panel-row">
              <button type="button" className="btn btn-sm" onClick={onUseText}>
                Use the text quiz
              </button>
            </div>
          </div>
        </div>
      )}

      {question && quiz && (
        <section className="coach-question" aria-label="Current question">
          <p className="question-meta">
            <span>
              Question {questionIndex + 1} of {quiz.questions.length}
            </span>
            <span className="question-topic">{TOPIC_LABEL[question.topic]}</span>
          </p>
          <p className="coach-prompt">{question.prompt}</p>
          <QuestionOptions question={question} />
          {state.pending === question.id && (
            <p className="muted">
              <span className="spinner" aria-hidden="true" /> Grading...
            </p>
          )}
          {quiz.results[question.id] && <p className={`coach-result stamp-${quiz.results[question.id]!.result}`}>{quiz.results[question.id]!.feedback}</p>}
        </section>
      )}

      <section className="coach-transcript" aria-label="Transcript">
        <p className="panel-label">Transcript</p>
        {turns.length === 0 ? (
          <p className="muted">What you and the coach say shows up here.</p>
        ) : (
          <ol ref={transcript} aria-live="polite">
            {turns.map((turn) => (
              <li key={turn.id} className={`turn turn-${turn.role}`}>
                <span className="turn-who">{turn.role === "agent" ? "Coach" : "You"}</span>
                <span className="turn-text">{turn.text}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function QuestionOptions({ question }: { question: QuestionOut }) {
  if (question.kind === "open") return <p className="field-hint">Answer in your own words.</p>;
  return (
    <ol className="coach-options">
      {question.options.map((option, i) => (
        <li key={option.id}>
          <span className="option-letter" aria-hidden="true">
            {optionLetter(i)}
          </span>
          {option.label}
        </li>
      ))}
    </ol>
  );
}
