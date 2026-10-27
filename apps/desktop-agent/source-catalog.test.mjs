import test from "node:test";
import assert from "node:assert/strict";
import { windowCatalog } from "./source-catalog.mjs";
import { validClipboard } from "../relay/protocol.mjs";

test("window IDs stay opaque and stable for the same handle/process; closed/reused handles lose their identity", () => {
  const sources = [{ id: "window:123:0", name: "Chrome\nTitle" }, { id: "window:456:0", name: "Agent" }, { id: "screen:1:0", name: "Screen" }];
  const native = [{ handle: "123", pid: 900, width: 1200, height: 800 }, { handle: "456", pid: 901, width: 600, height: 400 }];
  const first = windowCatalog(sources, native, new Map(), "456");
  assert.equal(first.publicSources.length, 1);
  const id = first.publicSources[0].id;
  assert.match(id, /^win-[\da-f-]{36}$/);
  assert.equal(first.publicSources[0].label, "Chrome Title");
  assert.equal(JSON.stringify(first.publicSources).includes('"pid"'), false);
  assert.equal(JSON.stringify(first.publicSources).includes('"handle"'), false);
  assert.equal(windowCatalog(sources, native, first.entries, "456").publicSources[0].id, id);
  assert.notEqual(windowCatalog(sources, [{ ...native[0], pid: 902 }], first.entries).publicSources[0].id, id);
  assert.equal(windowCatalog(sources, [], first.entries).entries.size, 0);
  assert.equal(windowCatalog(sources, [{ ...native[0], width: 0 }]).entries.size, 0);
});

test("clipboard bounds cover Unicode, NUL, unknown fields and replay counters", () => {
  const message = { type: "clipboard", sessionId: "fixture", screenId: "1", sequence: 1, requestId: "fixture-1", text: "Hello\n世界", paste: true };
  assert.equal(validClipboard(message), true);
  assert.equal(validClipboard({ ...message, text: "" }), true);
  assert.equal(validClipboard({ ...message, text: "\u0001".repeat(11000) }), false); // JSON escaping must fit the WebSocket frame.
  for (const patch of [{ text: "a".repeat(16385) }, { text: "😀".repeat(16384) }, { text: "a\0b" }, { text: null }, { paste: "yes" }, { sequence: 0 }, { sequence: Infinity }, { command: "powershell" }, { requestId: "bad id" }])
    assert.equal(validClipboard({ ...message, ...patch }), false);
});
