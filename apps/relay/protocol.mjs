export const IDLE_MS = 300000;
export const LEASE_MS = 45000;
// Text only, deliberately sent by the owner. Never poll or export a clipboard.
export function validClipboard(value) {
  return Boolean(value && typeof value === "object" &&
    Object.keys(value).every(key => ["type", "sessionId", "screenId", "sequence", "requestId", "text", "paste"].includes(key)) &&
    value.type === "clipboard" && typeof value.requestId === "string" && /^[\w-]{1,64}$/.test(value.requestId) &&
    typeof value.sessionId === "string" && value.sessionId.length > 0 && value.sessionId.length <= 64 &&
    typeof value.screenId === "string" && value.screenId.length > 0 && value.screenId.length <= 80 &&
    typeof value.text === "string" && value.text.length <= 16384 && !value.text.includes("\0") &&
    new TextEncoder().encode(value.text).length <= 49152 && typeof value.paste === "boolean" &&
    Number.isSafeInteger(value.sequence) && value.sequence > 0 &&
    new TextEncoder().encode(JSON.stringify(value)).length <= 60000);
}
export function validIceCandidate(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every(key => ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"].includes(key)) &&
    typeof value.candidate === "string" && value.candidate.length <= 2048 && (value.candidate === "" || value.candidate.startsWith("candidate:")) &&
    (value.sdpMid == null || typeof value.sdpMid === "string" && value.sdpMid.length <= 16) &&
    (value.sdpMLineIndex == null || Number.isInteger(value.sdpMLineIndex) && value.sdpMLineIndex >= 0 && value.sdpMLineIndex <= 8) &&
    (value.sdpMid != null || value.sdpMLineIndex != null) &&
    (value.usernameFragment == null || typeof value.usernameFragment === "string" && value.usernameFragment.length <= 256);
}
export const PAUSE_REASONS = Object.freeze(["local_takeover", "native_watchdog", "native_unavailable", "renderer_unavailable", "display_changed", "locked", "suspended"]);
const keyCodes = new Set([
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Backquote",
  "Comma",
  "Period",
  "Slash",
  ...Array.from({ length: 26 }, (_, i) => "Key" + String.fromCharCode(65 + i)),
  ...Array.from({ length: 10 }, (_, i) => "Digit" + i),
  ...Array.from({ length: 12 }, (_, i) => "F" + (i + 1)),
]);
export function validInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = {
    release: [],
    paste: [],
    move: ["x", "y"],
    down: ["x", "y", "button"],
    up: ["x", "y", "button"],
    wheel: ["deltaX", "deltaY"],
    keydown: ["code"],
    keyup: ["code"],
  }[value.kind];
  if (
    !fields ||
    Object.keys(value).some((k) => !["kind", ...fields].includes(k))
  )
    return false;
  if (
    ["move", "down", "up"].includes(value.kind) &&
    ![value.x, value.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
  )
    return false;
  if (["down", "up"].includes(value.kind) && ![0, 1, 2].includes(value.button))
    return false;
  if (["keydown", "keyup"].includes(value.kind) && !keyCodes.has(value.code))
    return false;
  if (
    value.kind === "wheel" &&
    ![value.deltaX, value.deltaY].every(
      (v) => Number.isInteger(v) && Math.abs(v) <= 1200,
    )
  )
    return false;
  return true;
}
export function profile(focused, fps = 60) {
  return focused
    ? {
        maxFramerate: fps === 30 ? 30 : 60,
        maxBitrate: 16000000,
        scaleResolutionDownBy: 1,
      }
    : { maxFramerate: 5, maxBitrate: 1200000, scaleResolutionDownBy: 2 };
}
export function quantile(values, q) {
  if (!values.length) return null;
  return [...values].sort((a, b) => a - b)[
    Math.max(0, Math.ceil(q * values.length) - 1)
  ];
}
export function relayAddress(raw) {
  const url = new URL(raw);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(url.hostname))
    )
  )
    throw new Error("INVALID_RELAY_URL");
  return url.origin;
}
