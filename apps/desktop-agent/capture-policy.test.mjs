import test from "node:test";
import assert from "node:assert/strict";
import { allowDisplayCapture } from "./capture-policy.mjs";
test("desktop permission is lease/frame bound and never grants camera or microphone access", () => {
  const request = { senderId: 1, expectedId: 1, frameUrl: "file:///app/index.html", entryUrl: "file:///app/index.html", isMainFrame: true, permission: "display-capture", mediaTypes: ["video"], active: true };
  assert.equal(allowDisplayCapture(request, "request"), true);
  assert.equal(allowDisplayCapture(request, "check"), true);
  assert.equal(allowDisplayCapture({ ...request, mediaTypes: ["video", "audio"] }, "request"), false);
  assert.equal(allowDisplayCapture({ ...request, mediaTypes: ["video", "audio"], audioAllowed: true }, "request"), true);
  assert.equal(allowDisplayCapture({ ...request, permission: "media", mediaTypes: ["audio"], audioAllowed: true }, "request"), false);
  for (const patch of [{ permission: "media" }, { permission: "geolocation" }, { active: false }, { frameUrl: "https://evil.example" }, { isMainFrame: false }, { senderId: 2 }, { mediaTypes: ["audio"] }, { mediaTypes: [] }]) assert.equal(allowDisplayCapture({ ...request, ...patch }, "request"), false);
});
import { canRestoreBackgroundAccess } from "./capture-policy.mjs";

test("background recovery requires saved local consent and every readiness check, never reviving a lease", () => {
  const ready = { allowRemote: true, paired: true, nativeReady: true, encryptedStorage: true, locked: false, pauseReason: "native_watchdog" };
  assert.equal(canRestoreBackgroundAccess(ready), true);
  for (const key of ["allowRemote", "paired", "nativeReady", "encryptedStorage"]) {
    assert.equal(canRestoreBackgroundAccess({ ...ready, [key]: false }), false);
    assert.equal(canRestoreBackgroundAccess({ ...ready, [key]: undefined }), false);
  }
  assert.equal(canRestoreBackgroundAccess({ ...ready, locked: true }), false);
  assert.equal(canRestoreBackgroundAccess({ ...ready, locked: undefined }), false);
  for (const pauseReason of [null, "local_takeover", "native_unavailable", "renderer_unavailable"])
    assert.equal(canRestoreBackgroundAccess({ ...ready, pauseReason }), false);
});
