export function allowDisplayCapture({ senderId, expectedId, frameUrl, entryUrl, isMainFrame, permission, mediaTypes, active, audioAllowed }, phase) {
  if (active !== true || senderId !== expectedId || !Number.isInteger(senderId) || frameUrl !== entryUrl || isMainFrame !== true || permission !== "display-capture") return false;
  return phase === "check" || phase === "request" && Array.isArray(mediaTypes) && mediaTypes.length > 0 && mediaTypes.every(type => type === "video" || type === "audio" && audioAllowed === true);
}
export function canRestoreBackgroundAccess({ allowRemote, paired, nativeReady, encryptedStorage, locked, pauseReason }) {
  return allowRemote === true && paired === true && nativeReady === true && encryptedStorage === true && locked === false &&
    ["locked", "suspended", "display_changed", "native_watchdog"].includes(pauseReason);
}
