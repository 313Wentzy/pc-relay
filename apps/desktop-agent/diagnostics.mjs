import { PAUSE_REASONS } from "../relay/protocol.mjs";
const connectionReasons = new Set(["connected", "connecting", "closed", "unavailable", "relay_timeout", "backpressure", "invalid_response", "response_rejected", "disconnected", "AUTH_REQUIRED", "AUTH_EXPIRED", "INVALID_TOKEN", "TOKEN_EXPIRED", "INVALID_PROOF", "INVALID_MESSAGE", "INVALID_SCREENS", "NO_SESSION", "RATE_LIMITED", "BACKPRESSURE", "REPLACED", "PAIRING_EXPIRED", "PAIRING_CANCELED", "PAIRING_REPLACED", "relay_error"]);
export function connectionDiagnostic(reason, at, closeCode = null) {
  return {
    reason: connectionReasons.has(reason) ? reason : "relay_error",
    at: Number.isFinite(at) ? new Date(at).toISOString() : null,
    closeCode: Number.isInteger(closeCode) && closeCode >= 1000 && closeCode <= 4999 ? closeCode : null,
  };
}
// This local snapshot contains no identity, IP, keys, credentials, screen names,
// command text/output, SDP, key codes or pointer coordinates.
export function diagnosticSnapshot(state, pause, captureError, now = Date.now()) {
  const source = ["mouse", "keyboard"].includes(pause?.source) ? pause.source : null;
  const stage = ["capture", "codec_preferences", "local_description", "profile"].includes(captureError?.stage) ? captureError.stage : null;
  const code = ["NotAllowedError", "NotReadableError", "AbortError", "OverconstrainedError", "InvalidStateError", "OperationError", "TypeError", "Error"].includes(captureError?.code) ? captureError.code : null;
  return {
    recordedAt: new Date(now).toISOString(),
    paired: state.paired === true,
    connected: state.connected === true,
    locallyEnabled: state.enabled === true,
    available: state.available === true,
    transportPause: PAUSE_REASONS.includes(state.pauseReason) ? state.pauseReason : null,
    activeSession: typeof state.activeSession === "string",
    nativeReady: state.nativeReady === true,
    elevated: state.elevated === true,
    encryptedStorage: state.encryptedStorage === true,
    screens: Array.isArray(state.screens) ? state.screens.length : 0,
    connection: state.connection ? connectionDiagnostic(state.connection.reason, Date.parse(state.connection.at), state.connection.closeCode) : null,
    pause: {
      reason: PAUSE_REASONS.includes(pause?.reason) ? pause.reason : "startup",
      at: Number.isFinite(pause?.at) ? new Date(pause.at).toISOString() : null,
      source,
      injected: source && typeof pause.injected === "boolean" ? pause.injected : null,
    },
    captureError: stage || code ? { stage, code } : null,
  };
}
