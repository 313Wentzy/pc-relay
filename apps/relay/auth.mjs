import {
  createHash,
  createHmac,
  timingSafeEqual,
  createPublicKey,
  verify,
} from "node:crypto";
export const OWNER = (process.env.RELAY_OWNER_EMAIL || "").trim().toLowerCase();
export const PROJECT = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
export function requireAuthConfiguration() {
  let project;
  try { project = new URL(PROJECT); } catch { throw Error("SUPABASE_URL_REQUIRED"); }
  if (project.protocol !== "https:" || project.origin !== PROJECT || project.username || project.password)
    throw Error("SUPABASE_URL_MUST_BE_HTTPS_ORIGIN");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(OWNER)) throw Error("RELAY_OWNER_EMAIL_REQUIRED");
  if (!process.env.SUPABASE_PUBLISHABLE_KEY?.startsWith("sb_publishable_")) throw Error("SUPABASE_PUBLISHABLE_KEY_REQUIRED");
}
export const DAY = 86400000;
export function signToken(secret, purpose, claims) {
  if (typeof secret !== "string" || secret.length < 32)
    throw new Error("RELAY_SECRET_REQUIRED");
  const body = Buffer.from(JSON.stringify({ purpose, ...claims })).toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  return body + "." + signature;
}
export function readToken(secret, purpose, token, now = Date.now(), issuedAtToleranceMs = 0) {
  if (typeof token !== "string" || token.length > 8192)
    throw new Error("INVALID_TOKEN");
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("INVALID_TOKEN");
  const expected = createHmac("sha256", secret).update(parts[0]).digest();
  const received = Buffer.from(parts[1], "base64url");
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  )
    throw new Error("INVALID_TOKEN");
  const data = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  if (
    data.purpose !== purpose ||
    !Number.isSafeInteger(data.issuedAt) ||
    !Number.isSafeInteger(data.expiresAt) ||
    now + issuedAtToleranceMs < data.issuedAt ||
    now >= data.expiresAt
  )
    throw new Error("TOKEN_EXPIRED");
  return data;
}
export function fingerprint(publicKey) {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("INVALID_KEY");
  const normalized = key.export({ type: "spki", format: "pem" });
  if (normalized !== publicKey) throw new Error("INVALID_KEY");
  return createHash("sha256").update(publicKey).digest("hex");
}
export function proofBody(nonce, certificate) {
  return JSON.stringify({
    purpose: "long-cable-relay-proof-v1",
    nonce,
    certificate,
  });
}
export function validProof(publicKey, nonce, certificate, signature) {
  try {
    if (typeof signature !== "string" || signature.length > 128) return false;
    fingerprint(publicKey);
    return verify(
      null,
      Buffer.from(proofBody(nonce, certificate)),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}
export async function providerOwner(
  accessToken,
  publishableKey,
  now = Date.now(),
  fetcher = fetch,
) {
  if (
    typeof accessToken !== "string" ||
    accessToken.length > 8192 ||
    !PROJECT || !OWNER || !publishableKey?.startsWith("sb_publishable_")
  )
    throw new Error("AUTH_REQUIRED");
  // Validate this exact token with Auth before interpreting any claims.
  const response = await fetcher(PROJECT + "/auth/v1/user", {
    headers: { apikey: publishableKey, Authorization: "Bearer " + accessToken },
    signal: AbortSignal.timeout(8000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("AUTH_REQUIRED");
  const user = await response.json();
  const claims = JSON.parse(
    Buffer.from(accessToken.split(".")[1], "base64url").toString(),
  );
  const times = (Array.isArray(claims.amr) ? claims.amr : [])
    .filter(
      (m) =>
        ["totp", "mfa/totp"].includes(m.method) &&
        Number.isSafeInteger(m.timestamp),
    )
    .map((m) => m.timestamp * 1000);
  const verifiedAt = times.length ? Math.max(...times) : 0;
  if (
    user.email?.toLowerCase() !== OWNER ||
    !user.email_confirmed_at ||
    !user.id ||
    typeof claims.session_id !== "string" ||
    claims.sub !== user.id ||
    claims.iss !== PROJECT + "/auth/v1" ||
    claims.role !== "authenticated" ||
    claims.aal !== "aal2" ||
    !Number.isSafeInteger(claims.exp) ||
    !Number.isSafeInteger(claims.iat) ||
    claims.iat * 1000 > now ||
    now - claims.iat * 1000 > 60000 ||
    claims.exp * 1000 <= now ||
    verifiedAt <= 0 ||
    now < verifiedAt ||
    now >= verifiedAt + DAY ||
    !user.factors?.some(
      (f) => f.factor_type === "totp" && f.status === "verified",
    )
  )
    throw new Error("OWNER_MFA_REQUIRED");
  return {
    ownerId: user.id,
    sessionId: claims.session_id,
    verifiedAt,
    trustExpiresAt: verifiedAt + DAY,
    expiresAt: Math.min(claims.exp * 1000, verifiedAt + DAY),
  };
}
