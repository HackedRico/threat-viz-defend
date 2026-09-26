import type { AudioType } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The plain parts of dictation, kept out of the component so they can be
// tested: which recording format to ask the browser for, how to name it to the
// server, how to encode the clip for a JSON body, and how the heard words join
// what the user already typed.

/** A recording stops on its own after this long; a spoken question fits well inside it. */
export const DICTATION_MAX_SECONDS = 60;

/** Clips smaller than this hold no speech; the server refuses them too. */
export const DICTATION_MIN_BYTES = 1_000;

/** Speech stays clear at this rate, and a full minute stays far under the request cap. */
export const DICTATION_BITS_PER_SECOND = 32_000;

// Opus in webm (Chrome, Edge, Firefox) first, then ogg, then mp4 for Safari.
const PREFERRED = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

const SERVER_TYPES: Record<string, AudioType> = {
  "audio/webm": "audio/webm",
  "video/webm": "audio/webm",
  "audio/ogg": "audio/ogg",
  "audio/mp4": "audio/mp4",
  "video/mp4": "audio/mp4",
  "audio/x-m4a": "audio/mp4",
  "audio/mpeg": "audio/mpeg",
  "audio/wav": "audio/wav",
};

/** The first recording format the browser supports, or `undefined` to let it choose. */
export function preferredRecordingType(isSupported: (type: string) => boolean): string | undefined {
  return PREFERRED.find((type) => isSupported(type));
}

/** The server's name for what the recorder produced, such as `audio/webm;codecs=opus`, or `null` when unsupported. */
export function audioTypeOf(recorderType: string): AudioType | null {
  const base = recorderType.split(";")[0]?.trim().toLowerCase() ?? "";
  return SERVER_TYPES[base] ?? null;
}

/** Base64 of `bytes`, built in slices so a long clip never overflows the argument list. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const slice = 0x8000;
  for (let start = 0; start < bytes.length; start += slice) {
    binary += String.fromCharCode(...bytes.subarray(start, start + slice));
  }
  return btoa(binary);
}

/** What the user typed with the heard words after it, cut to `max` characters. */
export function joinDictation(typed: string, heard: string, max: number): string {
  const words = heard.trim();
  if (!words) return typed;
  const gap = typed === "" || /\s$/.test(typed) ? "" : " ";
  return `${typed}${gap}${words}`.slice(0, max);
}

/** Seconds as `0:07`, for the timer on the button. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
