export const PAIRING_TTL_MS = 3 * 60 * 1000;
export function isTrustedSender({ senderId, expectedId, frameUrl, entryUrl }) {
  return (
    Number.isInteger(senderId) &&
    senderId === expectedId &&
    typeof frameUrl === "string" &&
    frameUrl === entryUrl
  );
}
export function canEnableStartup({ packaged, paired, encryptedStorage }) {
  return packaged === true && paired === true && encryptedStorage === true;
}
export function pairingStatus(request, now) {
  return request &&
    Number.isSafeInteger(now) &&
    now >= request.createdAt &&
    now < request.expiresAt &&
    request.expiresAt === request.createdAt + PAIRING_TTL_MS
    ? "pending_local_request"
    : "not_paired";
}
