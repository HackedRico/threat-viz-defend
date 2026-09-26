import { lazy, Suspense, type ComponentProps } from "react";

import type { ConfigOut } from "../api/types.ts";

// =============================================================================
// Module Overview
// =============================================================================
// The one door into voice: `voiceEnabled` is the only feature check, and
// `VoicePanel` is the only component the rest of the app renders. The SDK
// loads on first use, so boards without voice never download it.

const VoiceCoach = lazy(() => import("./VoiceCoach.tsx").then((module) => ({ default: module.VoiceCoach })));

/** True when this deployment has a voice agent configured. */
export function voiceEnabled(config: Pick<ConfigOut, "voice_enabled">): boolean {
  return config.voice_enabled;
}

/** The voice coach, loaded on demand. */
export function VoicePanel(props: ComponentProps<typeof VoiceCoach>) {
  return (
    <Suspense fallback={<p className="muted">Loading the voice coach...</p>}>
      <VoiceCoach {...props} />
    </Suspense>
  );
}
