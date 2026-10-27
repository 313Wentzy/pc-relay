import test from "node:test";
import assert from "node:assert/strict";
import {
  isTrustedSender,
  canEnableStartup,
  pairingStatus,
  PAIRING_TTL_MS,
} from "./agent-policy.mjs";
test("IPC rejects foreign window, remote content, and mismatched local document", () => {
  const expected = {
    senderId: 1,
    expectedId: 1,
    frameUrl: "file:///app/index.html",
    entryUrl: "file:///app/index.html",
  };
  assert.equal(isTrustedSender(expected), true);
  for (const change of [
    { senderId: 2 },
    { frameUrl: "https://attacker.example" },
    { frameUrl: "file:///other/index.html" },
  ])
    assert.equal(isTrustedSender({ ...expected, ...change }), false);
});
test("startup requires explicit packaged/paired/encrypted prerequisites", () => {
  assert.equal(
    canEnableStartup({ packaged: true, paired: true, encryptedStorage: true }),
    true,
  );
  for (const flag of ["packaged", "paired", "encryptedStorage"])
    assert.equal(
      canEnableStartup({
        packaged: true,
        paired: true,
        encryptedStorage: true,
        [flag]: false,
      }),
      false,
    );
});
test("local pairing request expires, never becomes approved, and rejects clock rollback", () => {
  const request = { createdAt: 1000, expiresAt: 1000 + PAIRING_TTL_MS };
  assert.equal(pairingStatus(request, 1000), "pending_local_request");
  assert.equal(pairingStatus(request, request.expiresAt), "not_paired");
  assert.equal(pairingStatus(request, 999), "not_paired");
  assert.equal(
    pairingStatus({ ...request, expiresAt: request.expiresAt + 1 }, 1000),
    "not_paired",
  );
});
