// =============================================================================
// Module Overview
// =============================================================================
// What to tell someone when the microphone will not open, for the dictate
// button and the voice coach alike. `micProblem` reads the error a browser
// rejects `getUserMedia` with and names the cause and the next step.

/** What kept the microphone from opening, told so the user knows what to do next. */
export function micProblem(error: unknown): string {
  const { name, message } = error instanceof DOMException ? error : { name: "", message: "" };
  if (name === "NotAllowedError" || name === "SecurityError") {
    // Chrome says why in the message; Firefox and Safari give one message for every refusal.
    if (/by system/i.test(message)) {
      return "Your computer is blocking this browser from using the microphone. Allow it in the system privacy settings, then try again.";
    }
    if (/dismissed/i.test(message)) return "The microphone prompt was closed. Press the mic again and choose Allow.";
    // A browser built into another app, such as an editor's preview pane, can refuse with no setting to change.
    return "The browser blocked the microphone. Allow it for this site from the icon beside the address. If this page is showing inside another app, open it in Chrome, Edge, Firefox or Safari instead.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. Plug one in, then try again.";
  return "The microphone could not start. Close other apps that use it, then try again.";
}
