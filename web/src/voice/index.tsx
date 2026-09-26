import { lazy, Suspense, type ComponentProps } from "react";

import type { ConfigOut } from "../api/types.ts";

export { DictateButton } from "./Dictation.tsx";
export { joinDictation } from "./dictation.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The one door into voice. `voiceEnabled` and `dictationEnabled` are the only
// feature checks, `VoicePanel` and `DictateButton` the only components the
// rest of the app renders, and `joinDictation` how heard words meet typed ones. The coach's SDK loads on first use, so boards
// without voice never download it; dictation needs no SDK.

const VoiceCoach = lazy(() => import("./VoiceCoach.tsx").then((module) => ({ default: module.VoiceCoach })));

/** True when this deployment has a voice agent configured. */
export function voiceEnabled(config: Pick<ConfigOut, "voice_enabled">): boolean {
  return config.voice_enabled;
}

/** True when this deployment can turn a spoken question into text. */
export function dictationEnabled(config: Pick<ConfigOut, "dictation_enabled">): boolean {
  return config.dictation_enabled;
}

/** The voice coach, loaded on demand. */
export function VoicePanel(props: ComponentProps<typeof VoiceCoach>) {
  return (
    <Suspense fallback={<p className="muted">Loading the voice coach...</p>}>
      <VoiceCoach {...props} />
    </Suspense>
  );
}
