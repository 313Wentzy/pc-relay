import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("./capture.js", import.meta.url), "utf8");
function fixture({ delayedCapture = false } = {}) {
  const calls = { captures: [], constraints: 0, parameters: 0, offers: [], failures: [], streams: [] };
  const timers = new Map(); let nextTimer = 0, receive, resolveCapture;
  function track(kind = "video") {
    return { kind, readyState: "live", enabled: true, settings: {}, stop() { this.readyState = "ended"; },
      async applyConstraints(value) { calls.constraints++; this.settings = Object.fromEntries(Object.entries(value).map(([key, value]) => [key, value.ideal])); }, getSettings() { return this.settings; } };
  }
  class Peer {
    constructor() { this.senders = []; this.localDescription = { sdp: "fixture" }; }
    createDataChannel() { return { readyState: "open", bufferedAmount: 0, send() {} }; }
    addTrack(track) {
      const sender = { track, params: { encodings: [{}] }, getParameters() { return structuredClone(this.params); },
        async setParameters(value) { calls.parameters++; this.params = value; }, async replaceTrack(value) { this.track = value; } };
      this.senders.push(sender); return sender;
    }
    getTransceivers() { return this.senders.map((sender, index) => ({ sender, mid: String(index), setCodecPreferences() {} })); }
    async createOffer() { return this.localDescription; }
    async setLocalDescription() {}
    async getStats() { return new Map(); }
    close() { this.closed = true; }
  }
  const context = vm.createContext({
    window: { longCableAgent: { onCapture: callback => { receive = callback; }, prepareCapture: async () => {},
      captureSignal: async value => calls.offers.push(value), captureFailed: (...value) => calls.failures.push(value) }, addEventListener() {} },
    navigator: { mediaDevices: { getDisplayMedia: async options => {
      calls.captures.push(options);
      if (delayedCapture) await new Promise(resolve => { resolveCapture = resolve; });
      const video = track(), audio = options.audio ? [track("audio")] : [];
      const stream = { getTracks: () => [video, ...audio], getVideoTracks: () => [video], getAudioTracks: () => audio };
      calls.streams.push(stream); return stream;
    } } },
    RTCPeerConnection: Peer, RTCRtpSender: { getCapabilities: () => ({ codecs: [] }) },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(source, context);
  const message = value => { receive({ sessionId: "test", ...value }); return vm.runInContext("queue", context); };
  return { calls, timers, context, message,
    start: () => message({ type: "start", focus: "1", fps: 60, height: 1080, audio: true, iceServers: [], sources: [{ screenId: "1" }, { screenId: "2" }] }),
    advance: async () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); await vm.runInContext("queue", context); },
    resolve: () => resolveCapture(), state: () => vm.runInContext("state", context),
  };
}
test("secondary capture begins at 540p/5 FPS; unchanged focus/visibility never reconfigures tracks", async () => {
  const f = fixture(); await f.start();
  assert.equal(f.calls.captures[0].video.height.max, 1080);
  assert.equal(f.calls.captures[1].video.height.max, 540);
  assert.equal(f.calls.captures[1].video.frameRate.max, 5);
  const before = { constraints: f.calls.constraints, parameters: f.calls.parameters };
  for (let i = 0; i < 25; i++) { await f.message({ type: "focus", screenId: "1" }); await f.message({ type: "visibility", screenIds: ["1", "2"] }); }
  assert.equal(f.calls.constraints, before.constraints);
  assert.equal(f.calls.parameters, before.parameters);
  await f.message({ type: "focus", screenId: "2" });
  assert.equal(f.state().media[1].track.settings.height, 1080);
  assert.equal(f.state().media[1].sender.params.encodings[0].scaleResolutionDownBy, 1);
  assert.deepEqual(f.calls.failures, []);
});
test("hidden captures release after grace, preserve audio and restore on the same peer and MID", async () => {
  const f = fixture(); await f.start(); const state = f.state(), audio = state.audioTracks[0], sender = state.media[0].sender;
  await f.message({ type: "visibility", screenIds: [] });
  assert.equal(f.timers.size, 2);
  await f.advance();
  assert.ok(state.media.every(item => item.track === null && item.sender.track === null));
  assert.equal(audio.readyState, "live");
  assert.ok(f.calls.streams.every(stream => stream.getVideoTracks()[0].readyState === "ended"));
  await f.message({ type: "visibility", screenIds: ["1", "2"] });
  assert.equal(f.state(), state);
  assert.equal(state.media[0].sender, sender);
  assert.equal(state.media[0].track.readyState, "live");
  assert.equal(f.calls.captures.length, 4);
  assert.equal(f.calls.captures.slice(2).some(options => options.audio !== false), false);
  assert.equal(f.calls.offers.length, 1);
  await f.message({ type: "stop" });
  assert.equal(audio.readyState, "ended");
  assert.equal(f.timers.size, 0);
  assert.ok(f.calls.streams.every(stream => stream.getTracks().every(track => track.readyState === "ended")));
  assert.deepEqual(f.calls.failures, []);
});
test("a brief hide does not churn capture and stop fences pending suspension timers", async () => {
  const f = fixture(); await f.start();
  await f.message({ type: "visibility", screenIds: ["1"] });
  await f.message({ type: "visibility", screenIds: ["1", "2"] });
  assert.equal(f.timers.size, 0); assert.equal(f.calls.captures.length, 2);
  await f.message({ type: "visibility", screenIds: [] });
  await f.message({ type: "stop" }); await f.advance();
  assert.equal(f.state(), null); assert.equal(f.calls.captures.length, 2);
});
test("stop during capture acquisition stops late tracks without publishing an offer", async () => {
  const f = fixture({ delayedCapture: true }); const starting = f.start();
  while (!f.calls.captures.length) await Promise.resolve();
  void f.message({ type: "stop" }); f.resolve(); await starting;
  assert.equal(f.state(), null); assert.equal(f.calls.offers.length, 0);
  assert.ok(f.calls.streams.every(stream => stream.getTracks().every(track => track.readyState === "ended")));
});
