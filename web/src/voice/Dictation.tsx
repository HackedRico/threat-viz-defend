import { useEffect, useRef, useState, type RefObject } from "react";

import { api, errorMessage } from "../api/client.ts";
import { MicIcon } from "../shell/icons.tsx";
import { useSession } from "../shell/session.tsx";
import {
  audioTypeOf,
  clock,
  DICTATION_BITS_PER_SECOND,
  DICTATION_MAX_SECONDS,
  DICTATION_MIN_BYTES,
  preferredRecordingType,
  toBase64,
} from "./dictation.ts";
import "./Dictation.css";

// =============================================================================
// Module Overview
// =============================================================================
// The dictate button: press to record a question, press again to have
// ElevenLabs Speech to Text write it down. The clip goes to our own API, which
// holds the ElevenLabs key, and the words come back for the caller to put in
// front of the user, who reads them before sending. Escape throws a recording
// away, and a recording stops by itself after a minute. The button shows even
// when the server has no ElevenLabs key, so people can find it; pressing it
// then says dictation is off and never opens the microphone.

type Phase = "idle" | "starting" | "recording" | "sending";

const OFF_MESSAGE = "Dictation is not set up on this server yet, since it has no ElevenLabs API key. Type your question for now.";

interface Take {
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  keep: boolean;
  timer: number;
}

interface DictateProps {
  /** False when the server cannot transcribe; the button then explains instead of recording. */
  available: boolean;
  /** Receives the heard words, trimmed and never empty. */
  onText: (text: string) => void;
  /** Receives a message for the user, or `null` to clear an earlier one. */
  onError: (message: string | null) => void;
  disabled?: boolean;
}

/** A mic button that turns a spoken question into text. */
export function DictateButton({ available, onText, onError, disabled = false }: DictateProps) {
  const { me, refreshMe } = useSession();
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const take = useRef<Take | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const recording = phase === "recording";

  // Leaving the page mid-recording throws the clip away and turns the mic off.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      finish(false);
    };
  }, []);

  useEffect(() => {
    if (!recording) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [recording]);

  useMicLevel(stream, button);

  const start = async () => {
    onError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onError("This browser cannot record here. Type your question, or use a current browser over https.");
      return;
    }
    setPhase("starting");
    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (caught) {
      const denied = caught instanceof DOMException && (caught.name === "NotAllowedError" || caught.name === "SecurityError");
      setPhase("idle");
      onError(
        denied
          ? "Microphone access is blocked. Allow it in your browser's site settings, then try again."
          : "No microphone was found. Plug one in, or type your question.",
      );
      return;
    }
    if (!alive.current) {
      mic.getTracks().forEach((track) => track.stop());
      return;
    }
    const mimeType = preferredRecordingType((type) => MediaRecorder.isTypeSupported(type));
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(mic, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: DICTATION_BITS_PER_SECOND });
    } catch {
      mic.getTracks().forEach((track) => track.stop());
      setPhase("idle");
      onError("This browser cannot record audio here. Type your question instead.");
      return;
    }
    const current: Take = { recorder, stream: mic, chunks: [], keep: true, timer: 0 };
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) current.chunks.push(event.data);
    };
    recorder.onstop = () => {
      current.stream.getTracks().forEach((track) => track.stop());
      if (!current.keep) return;
      const type = recorder.mimeType || mimeType || "";
      void send(new Blob(current.chunks, { type }), type);
    };
    const began = performance.now();
    current.timer = window.setInterval(() => {
      const seconds = (performance.now() - began) / 1000;
      setElapsed(seconds);
      if (seconds >= DICTATION_MAX_SECONDS) finish(true);
    }, 250);
    take.current = current;
    setStream(mic);
    setElapsed(0);
    recorder.start();
    setPhase("recording");
  };

  /** Stop recording, then send the clip when `keep` is true or throw it away. */
  function finish(keep: boolean) {
    const current = take.current;
    if (!current) return;
    take.current = null;
    current.keep = keep;
    window.clearInterval(current.timer);
    if (current.recorder.state === "inactive") current.stream.getTracks().forEach((track) => track.stop());
    else current.recorder.stop();
    if (!alive.current) return;
    setStream(null);
    setPhase(keep ? "sending" : "idle");
  }

  const send = async (clip: Blob, recorderType: string) => {
    const audioType = audioTypeOf(recorderType);
    try {
      if (audioType === null) {
        onError("This browser records in a format the server cannot read. Type your question instead.");
      } else if (clip.size < DICTATION_MIN_BYTES) {
        onError("That was too short to hear. Speak, then press stop.");
      } else {
        const audio = toBase64(new Uint8Array(await clip.arrayBuffer()));
        const { text } = await api.dictate({ audio, audio_type: audioType });
        if (!alive.current) return;
        if (text) onText(text);
        else onError("No speech was heard. Try again a little closer to the microphone.");
        refreshMe();
      }
    } catch (caught) {
      if (alive.current) onError(errorMessage(caught));
    } finally {
      if (alive.current) setPhase("idle");
    }
  };

  const left = me.usage.dictations_limit - me.usage.dictations_today;
  const label = recording ? "Stop and write down your question" : phase === "sending" ? "Writing down your question" : "Speak your question";
  const hint = !available
    ? "Dictation is not set up on this server yet."
    : recording
      ? "Recording. Press again to stop, or Escape to throw it away."
      : `Speak your question instead of typing it. ${left > 0 ? `${left} dictation${left === 1 ? "" : "s"} left today.` : "No dictations left today."}`;

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`btn dictate ${recording ? "is-recording" : ""} ${available ? "" : "is-off"}`}
        aria-label={label}
        aria-pressed={recording}
        // Still focusable and pressable when off, so the press can say why instead of doing nothing.
        aria-disabled={!available}
        title={hint}
        // A recording in progress can always be stopped, even while the caller is busy.
        disabled={(disabled && !recording) || phase === "starting" || phase === "sending"}
        onClick={() => (!available ? onError(OFF_MESSAGE) : recording ? finish(true) : void start())}
      >
        {phase === "starting" || phase === "sending" ? (
          <span className="spinner" aria-hidden="true" />
        ) : recording ? (
          <span className="dictate-stop" aria-hidden="true" />
        ) : (
          <MicIcon width={18} height={18} />
        )}
        {recording && (
          <span className="dictate-clock" aria-hidden="true">
            {clock(elapsed)}
          </span>
        )}
      </button>
      <span className="visually-hidden" role="status">
        {recording ? hint : phase === "sending" ? "Writing down your question..." : ""}
      </span>
    </>
  );
}

/** Drive the button's `--level` from the mic's loudness, so people can see it hears them; off for reduced motion. */
function useMicLevel(stream: MediaStream | null, target: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = target.current;
    if (!stream || !el || matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let frame = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      el.style.setProperty("--level", Math.min(1, Math.sqrt(sum / samples.length) * 6).toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      el.style.removeProperty("--level");
      void context.close();
    };
  }, [stream, target]);
}
