import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { createRelay } from "../relay/server.mjs";
import { fingerprint, signToken } from "../relay/auth.mjs";
import { AgentRelay } from "./relay-client.mjs";
import { CommandRunner, commandSpec } from "./command-runner.mjs";

const wait = async (predicate) => {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("relay failover preserves the saved permission and never retries an authentication rejection", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sockets = [];
  class Socket extends EventTarget {
    readyState = 1; bufferedAmount = 0;
    constructor(url) { super(); this.url = url; sockets.push(this); }
    send() {}
    close() { this.readyState = 3; }
    fail(code) { this.readyState = 3; const event = new Event("close"); event.code = code; event.reason = ""; this.dispatchEvent(event); }
  }
  const origins = ["https://relay.example.com", "https://backup.example.com"];
  const { agent } = accessFixture(t, { relayOrigins: origins, WebSocketClass: Socket,
    vault: { readState: async () => ({ relay: origins[0], certificate: "fixture-only", allowRemote: false }) } });
  await agent.restore();
  sockets[0].fail(1011);
  t.mock.timers.tick(1000); await Promise.resolve();
  assert.equal(sockets[1].url, "wss://backup.example.com/connect");
  assert.equal(agent.enabled, false);
  assert.equal(agent.session, null);
  sockets[1].fail(1008);
  t.mock.timers.tick(60000); await Promise.resolve();
  assert.equal(sockets.length, 2);
});

test("an authenticated socket handshake that stalls rotates to the other hostname", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const urls = [];
  class Socket extends EventTarget { readyState = 1; bufferedAmount = 0; constructor(url) { super(); urls.push(url); } send() {} close() { this.readyState = 3; } }
  const { agent } = accessFixture(t, { relayOrigins: ["https://relay.example.com", "https://backup.example.com"], WebSocketClass: Socket,
    clock: () => ({ wall: 100000 + now, mono: now }) });
  await agent.connect("https://relay.example.com");
  now = 11000; agent.tick();
  t.mock.timers.tick(1000); await Promise.resolve();
  assert.equal(urls.at(-1), "wss://backup.example.com/connect");
});

function accessFixture(t, overrides = {}) {
  const snapshots = [], captures = [], messages = [];
  let stored, released = 0, commandStops = 0;
  const agent = new AgentRelay({
    vault: { writeState: async value => { stored = value; } }, screens: () => [{ id: "1" }],
    capture: async value => captures.push(value), input: async () => {},
    release: () => released++, command: async () => {}, stopCommand: () => commandStops++,
    onStatus: value => snapshots.push(value), ...overrides,
  });
  agent.state = { relay: "http://127.0.0.1:8790", certificate: "synthetic-certificate" };
  agent.ws = { readyState: 1, bufferedAmount: 0, send: value => messages.push(JSON.parse(value)), close() {} };
  agent.connected = true;
  t.after(() => agent.close());
  return { agent, snapshots, captures, messages, stored: () => stored, released: () => released, commandStops: () => commandStops };
}

test("a local takeover fences an automatic restart even before the relay receives the status update", async t => {
  const { agent, captures, messages } = accessFixture(t);
  agent.enable(true);
  const fence = agent.recoveryFence();
  agent.pause("local_takeover");
  await agent.receive({ type: "started", sessionId: "stale-recovery", screenIds: ["1"], recoveryFence: fence,
    expiresAt: Date.now() + 40000, trustExpiresAt: Date.now() + 86400000 });
  assert.equal(agent.session, null);
  assert.equal(captures.some(value => value.type === "start"), false);
  assert.equal(messages.at(-1).reason, "local_takeover");
});

test("clipboard writes require a current scoped lease; paste follows the write and succeeds only on native ACK", async t => {
  const calls = [];
  const { agent, messages } = accessFixture(t, {
    clipboard: message => calls.push({ type: "write", text: message.text }),
    input: async message => { if (message.type !== "begin") calls.push({ type: "input", kind: message.input.kind }); },
  });
  const message = { type: "clipboard", sessionId: "clipboard-fixture", screenId: "1", sequence: 1, requestId: "paste-1", text: "Synthetic clipboard", paste: true };
  await agent.receive(message); assert.equal(calls.length, 0);
  agent.enable(true);
  await agent.receive({ type: "started", sessionId: message.sessionId, screenIds: ["1"], expiresAt: Date.now() + 40000, trustExpiresAt: Date.now() + 86400000 });
  await agent.receive({ ...message, screenId: "other" }); assert.equal(calls.length, 0);
  await agent.receive(message);
  assert.deepEqual(calls, [{ type: "write", text: message.text }, { type: "input", kind: "paste" }]);
  assert.equal(messages.some(item => item.type === "clipboard-result"), false);
  agent.acknowledge(1);
  assert.equal(messages.find(item => item.type === "clipboard-result").ok, true);
  await agent.receive(message); assert.equal(calls.length, 2);
  agent.pause("local_takeover");
  await agent.receive({ ...message, sequence: 2 }); assert.equal(calls.length, 2);
});

test("idle checks run at 1 Hz; starting a lease immediately restores the 100 ms native watchdog", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 0, checks = 0, heartbeats = 0;
  const { agent } = accessFixture(t, { clock: () => ({ wall: 100000 + now, mono: now }), heartbeat: () => heartbeats++ });
  agent.lastRelayMessage = 0;
  const tick = agent.tick.bind(agent); agent.tick = () => { checks++; tick(); };
  for (let i = 0; i < 10; i++) { now += 100; t.mock.timers.tick(100); }
  assert.equal(checks, 1); assert.equal(heartbeats, 0);
  agent.enable(true);
  await agent.receive({ type: "started", sessionId: "watch-fixture", screenIds: ["1"], expiresAt: 140000, trustExpiresAt: 200000 }, agent.generation);
  assert.equal(agent.watchPeriod, 100);
  for (let i = 0; i < 10; i++) { now += 100; t.mock.timers.tick(100); }
  assert.equal(checks, 11); assert.equal(heartbeats, 10);
  agent.pause("local_takeover"); assert.equal(agent.watchPeriod, 1000);
  agent.close();
  const count = checks; t.mock.timers.tick(10000); assert.equal(checks, count);
});

test("local takeover ends the lease without turning off the saved access switch", async t => {
  const state = accessFixture(t), { agent } = state;
  await agent.setAccessEnabled(true);
  const start = id => ({ type: "started", sessionId: id, screenIds: ["1"], expiresAt: Date.now() + 40000, trustExpiresAt: Date.now() + 86400000 });
  await agent.receive(start("old-session"), agent.generation);
  assert.equal(agent.authorized("old-session"), true);
  agent.pause("local_takeover");
  assert.equal(agent.status().enabled, true);
  assert.equal(state.stored().allowRemote, true);
  assert.equal(agent.status().available, true);
  assert.equal(agent.authorized("old-session"), false);
  assert.equal(agent.session, null);
  assert.equal(state.captures.at(-1).type, "stop");
  assert.ok(state.released() > 0 && state.commandStops() > 0);
  assert.equal(state.messages.find(m => m.type === "end").reason, "local_takeover");
  // No automatic restart. Only a new scoped session can resume capture.
  assert.equal(state.captures.filter(m => m.type === "start").length, 1);
  await agent.receive(start("new-session"), agent.generation);
  assert.equal(agent.authorized("old-session"), false);
  assert.equal(agent.authorized("new-session"), true);
});

test("WebRTC input uses the same screen, replay and native-ACK authorization as relay input", async t => {
  const injected = [], acks = [];
  const { agent, messages } = accessFixture(t, { input: async value => { if (value.type === "input") injected.push(value); } });
  agent.enable(true);
  await agent.receive({ type: "started", sessionId: "fixture-lease", screenIds: ["1"], expiresAt: Date.now() + 40000, trustExpiresAt: Date.now() + 86400000 }, agent.generation);
  const packet = { type: "input", sessionId: "fixture-lease", screenId: "1", sequence: 1, input: { kind: "move", x: 0.2, y: 0.4 } };
  assert.equal(await agent.acceptInput({ ...packet, screenId: "other" }, value => acks.push(value)), false);
  assert.equal(await agent.acceptInput({ ...packet, type: "command" }, value => acks.push(value)), false);
  assert.equal(await agent.acceptInput(packet, value => acks.push(value)), true);
  assert.equal(acks.length, 0); // Sending to the broker is not a native injection ACK.
  agent.acknowledge(1);
  assert.equal(acks[0].sequence, 1);
  assert.equal(messages.find(value => value.type === "direct-input-ack").screenId, "1");
  assert.equal(await agent.acceptInput(packet, value => acks.push(value)), false);
  agent.pause("local_takeover");
  assert.equal(await agent.acceptInput({ ...packet, sequence: 2 }, value => acks.push(value)), false);
  assert.equal(injected.length, 1);
  assert.equal(agent.enabled, true);
});

test("monitor visibility is lease-scoped and cannot renew idle authorization", async t => {
  let now = 100;
  const { agent, captures } = accessFixture(t, { clock: () => ({ wall: Date.now(), mono: now }) });
  agent.enable(true);
  await agent.receive({ type: "started", sessionId: "visibility-lease", screenIds: ["1"], expiresAt: Date.now() + 40000, trustExpiresAt: Date.now() + 86400000 }, agent.generation);
  const activity = agent.session.activity;
  now += 500;
  for (const screenIds of [[], ["1"]]) {
    await agent.receive({ type: "visibility", sessionId: "visibility-lease", screenIds }, agent.generation);
    assert.deepEqual(captures.at(-1).screenIds, screenIds);
    assert.equal(agent.session.activity, activity);
  }
  const count = captures.length;
  for (const packet of [
    { sessionId: "other", screenIds: ["1"] },
    { sessionId: "visibility-lease", screenIds: ["other"] },
    { sessionId: "visibility-lease", screenIds: ["1", "1"] },
    { sessionId: "visibility-lease", screenIds: "1" },
  ]) await agent.receive({ type: "visibility", ...packet }, agent.generation);
  assert.equal(captures.length, count);
  agent.pause("local_takeover");
  await agent.receive({ type: "visibility", sessionId: "visibility-lease", screenIds: ["1"] }, agent.generation);
  assert.equal(captures.at(-1).type, "stop");
});

test("trickle ICE stays scoped, bounded and cannot grant audio or extend idle time", async t => {
  const { agent, captures, messages } = accessFixture(t);
  agent.enable(true);
  await agent.receive({ type: "started", sessionId: "ice-lease", screenIds: ["1"], audio: false, expiresAt: Date.now() + 40000, trustExpiresAt: Date.now() + 86400000 }, agent.generation);
  const activity = agent.session.activity, candidate = { candidate: "candidate:fixture", sdpMid: "0", sdpMLineIndex: 0 };
  assert.equal(agent.session.audio, false);
  await agent.receive({ type: "ice", sessionId: "ice-lease", candidate }, agent.generation);
  assert.equal(captures.at(-1).type, "ice");
  assert.equal(agent.session.activity, activity);
  agent.ice({ sessionId: "other", candidate });
  agent.ice({ sessionId: "ice-lease", candidate: { candidate: "invalid" } });
  for (let i = 0; i < 129; i++) agent.ice({ sessionId: "ice-lease", candidate });
  assert.equal(messages.filter(value => value.type === "ice").length, 128);
  assert.equal(agent.session.activity, activity);
  agent.pause("local_takeover");
  agent.ice({ sessionId: "ice-lease", candidate });
  assert.equal(messages.filter(value => value.type === "ice").length, 128);
});

test("a saved access setting survives restart but never bypasses native readiness or safety pauses", async t => {
  const state = accessFixture(t);
  await state.agent.setAccessEnabled(true);
  let ready = false;
  class Socket extends EventTarget { readyState = 1; bufferedAmount = 0; send() {} close() {} }
  const restored = accessFixture(t, { vault: { readState: async () => state.stored() }, ready: () => ready, WebSocketClass: Socket }).agent;
  await restored.restore();
  await restored.receive({ type: "agent-ready" }, restored.generation);
  assert.equal(restored.status().enabled, true);
  assert.equal(restored.status().available, false);
  ready = true;
  assert.equal(restored.status().available, true);
  restored.pause("locked");
  assert.equal(restored.status().enabled, true);
  assert.equal(restored.status().available, false);
  assert.equal(restored.status().pauseReason, "locked");
  await restored.receive({ type: "started", sessionId: "denied", screenIds: ["1"], expiresAt: Date.now() + 40000, trustExpiresAt: Date.now() + 86400000 }, restored.generation);
  assert.equal(restored.session, null);
});

test("turning access off fences immediately and a failed setting save cannot grant access", async t => {
  let finish;
  const state = accessFixture(t, { vault: { writeState: () => new Promise(resolve => { finish = resolve; }) } });
  const enabling = state.agent.setAccessEnabled(true);
  await Promise.resolve();
  assert.equal(state.agent.enabled, false);
  finish(); await enabling;
  assert.equal(state.agent.enabled, true);
  const disabling = state.agent.setAccessEnabled(false);
  assert.equal(state.agent.enabled, false);
  await Promise.resolve(); finish(); await disabling;
  assert.equal(state.agent.state.allowRemote, false);
  const broken = accessFixture(t, { vault: { writeState: async () => { throw Error("storage failed"); } } }).agent;
  await assert.rejects(broken.setAccessEnabled(true), /ACCESS_SETTING_NOT_SAVED/);
  assert.equal(broken.enabled, false);
});

test("a safety pause during an in-flight save is not cleared when that save finishes", async t => {
  let finish;
  const { agent } = accessFixture(t, { vault: { writeState: () => new Promise(resolve => { finish = resolve; }) } });
  const setting = agent.setAccessEnabled(true);
  await Promise.resolve();
  agent.pause("locked");
  finish(); await setting;
  assert.equal(agent.enabled, true);
  assert.equal(agent.status().pauseReason, "locked");
  assert.equal(agent.status().available, false);
});

test("unpairing cannot be undone by an older permission save finishing later", async t => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  let stored;
  const { agent } = accessFixture(t, { vault: { writeState: async value => { if (value) await gate; stored = value; } } });
  const enabling = agent.setAccessEnabled(true);
  await Promise.resolve();
  const unpairing = agent.unpair();
  finish();
  await Promise.all([enabling, unpairing]);
  assert.equal(stored, null);
  assert.equal(agent.state, null);
  assert.equal(agent.enabled, false);
});

test("unpair publishes cleared connection state to the UI and status diagnostics", async (t) => {
  const snapshots = [];
  let stored;
  const agent = new AgentRelay({
    vault: { writeState: async value => { stored = value; } }, screens: () => [],
    capture: async () => {}, input: async () => {}, release: () => {},
    command: async () => {}, stopCommand: () => {},
    onStatus: value => snapshots.push(value),
  });
  t.after(() => agent.close());
  agent.state = { certificate: "synthetic-certificate", relay: "http://127.0.0.1:8790" };
  agent.enable(true);
  await agent.unpair();
  assert.equal(stored, null);
  assert.equal(snapshots.at(-1).paired, false);
  assert.equal(snapshots.at(-1).relay, "");
  assert.equal(snapshots.at(-1).enabled, false);
  assert.equal(snapshots.at(-1).connected, false);
  assert.equal(snapshots.at(-1).message, "Unpaired");
});
test("policy disconnect preserves a bounded reason and fences the live session", async (t) => {
  class Socket extends EventTarget {
    readyState = 1;
    bufferedAmount = 0;
    send() {}
    close() { this.readyState = 3; }
  }
  let released = 0;
  const agent = new AgentRelay({ vault: {}, screens: () => [], capture: async () => {}, input: async () => {}, release: () => released++, command: async () => {}, stopCommand: () => {}, WebSocketClass: Socket });
  t.after(() => agent.close());
  await agent.connect("http://127.0.0.1:8790");
  const generation = agent.generation;
  await agent.receive({ type: "agent-ready" }, generation);
  agent.enable(true);
  agent.session = { id: "fixture-lease" };
  const closed = new Event("close");
  Object.assign(closed, { code: 1008, reason: "RATE_LIMITED" });
  agent.ws.dispatchEvent(closed);
  assert.equal(agent.status().connected, false);
  assert.equal(agent.session, null);
  assert.equal(agent.authorized("fixture-lease"), false);
  assert.equal(agent.status().connection.reason, "RATE_LIMITED");
  assert.equal(agent.status().connection.closeCode, 1008);
  assert.match(agent.status().message, /RATE LIMITED/);
  assert.equal(agent.retry, undefined);
  assert.ok(released > 0);
});
test("agent independently fences expired/idle/local-takeover sessions and clears capture/commands", async (t) => {
  let now = { wall: 1800000000000, mono: 1000 },
    releases = 0,
    stops = 0,
    captures = [];
  const agent = new AgentRelay({
    vault: {},
    screens: () => [],
    capture: async (value) => captures.push(value),
    input: async () => {},
    release: () => releases++,
    command: async () => {},
    stopCommand: () => stops++,
    clock: () => ({ ...now }),
  });
  t.after(() => agent.close());
  agent.connected = true;
  agent.enable(true);
  agent.session = {
    id: "lease",
    deadline: now.mono + 45000,
    trustDeadline: now.mono + 86400000,
    expiresAt: now.wall + 45000,
    activity: now.mono,
  };
  assert.equal(agent.authorized("lease"), true);
  now = { wall: now.wall + 45000, mono: now.mono + 45000 };
  agent.tick();
  assert.equal(agent.session, null);
  assert.ok(releases > 0);
  assert.ok(stops > 0);
  assert.equal(captures.at(-1).type, "stop");
  agent.enable(true);
  agent.session = {
    id: "new",
    deadline: now.mono + 45000,
    trustDeadline: now.mono + 86400000,
    expiresAt: now.wall + 45000,
    activity: now.mono - 300000,
  };
  assert.equal(agent.authorized("new"), false);
  agent.tick();
  assert.equal(agent.session, null);
  agent.enable(true);
  agent.session = {
    id: "local",
    deadline: now.mono + 45000,
    trustDeadline: now.mono + 86400000,
    expiresAt: now.wall + 45000,
    activity: now.mono,
  };
  agent.enable(false, "native_watchdog");
  assert.equal(agent.authorized("local"), false);
  assert.equal(agent.status().pauseReason, "native_watchdog");
});
test("real relay plus actual agent transport returns PC probe and shell output", async (t) => {
  const secret = randomBytes(32).toString("hex"),
    auth = randomBytes(24).toString("hex"),
    trust = Date.now() + 86400000;
  const relay = createRelay({
    secret,
    authenticate: async (token) => {
      if (token !== auth) throw new Error("AUTH_REQUIRED");
      return {
        ownerId: "fixture-owner",
        sessionId: "fixture-session",
        trustExpiresAt: trust,
        expiresAt: Date.now() + 3600000,
      };
    },
  });
  await new Promise((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  t.after(() => relay.close());
  const base = "http://127.0.0.1:" + relay.server.address().port,
    keys = generateKeyPairSync("ed25519"),
    publicKey = keys.publicKey.export({ type: "spki", format: "pem" }),
    id = fingerprint(publicKey);
  const certificate = signToken(secret, "agent", {
    ownerId: "fixture-owner",
    deviceId: id,
    publicKey,
    name: "Fixture PC",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 86400000,
  });
  const vault = {
    readState: async () => ({ relay: base, certificate }),
    signRelay: async (body) =>
      sign(null, Buffer.from(body), keys.privateKey).toString("base64url"),
    publicIdentity: () => ({ publicKey, fingerprint: id }),
  };
  let agent;
  const runner = new CommandRunner({
    authorize: async (lease) => agent.authorized(lease.sessionId),
  });
  const captures = [];
  agent = new AgentRelay({
    vault,
    screens: () => [
      { id: "1", label: "Fixture screen", width: 1920, height: 1080 },
    ],
    capture: async (value) => captures.push(value),
    input: async (message) => {
      if (message.type === "input") agent.acknowledge(message.sequence);
    },
    release: () => {},
    command: (message, callback) =>
      process.platform === "win32"
        ? runner.start(
            {
              shell: message.shell,
              command: message.command,
              admin: false,
              lease: { sessionId: message.sessionId },
            },
            callback,
          )
        : Promise.resolve(
            callback({
              type: "exit",
              code: 0,
              reason: "synthetic_non_windows",
            }),
          ),
    stopCommand: () => runner.stop(),
    WebSocketClass: WebSocket,
  });
  t.after(() => agent.close());
  await agent.restore();
  await wait(() => agent.connected);
  assert.equal(agent.enabled, false);
  agent.enable(true);
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/connect", {
      origin: base,
    }),
    messages = [];
  ws.on("message", (data) => {
    const value = JSON.parse(data);
    messages.push(value);
    if (value.type === "challenge")
      ws.send(JSON.stringify({ type: "auth", accessToken: auth }));
  });
  t.after(() => ws.close());
  const send = (value) => ws.send(JSON.stringify(value));
  await wait(() =>
    messages.some((m) => m.type === "devices" && m.devices[0]?.available),
  );
  send({ type: "start", deviceId: id, screenIds: ["1"], fps: 60 });
  await wait(() => messages.some((m) => m.type === "started"));
  const session = messages.find((m) => m.type === "started");
  await wait(() => captures.some((m) => m.type === "start"));
  send({ type: "probe", sessionId: session.sessionId, id: "probe" });
  await wait(() => messages.some((m) => m.type === "probe-ack"));
  send({
    type: "input",
    sessionId: session.sessionId,
    sequence: 1,
    screenId: "1",
    input: { kind: "move", x: 0.5, y: 0.5 },
  });
  await wait(() => messages.some((m) => m.type === "input-ack"));
  send({
    type: "command",
    sessionId: session.sessionId,
    requestId: "read-only-test",
    shell: "powershell",
    command: "Write-Output 'long-cable-remote-transport-ok'",
    admin: false,
  });
  await wait(() =>
    messages.some((m) => m.type === "command-event" && m.event.type === "exit"),
  );
  if (process.platform === "win32")
    assert.ok(
      messages.some(
        (m) =>
          m.type === "command-event" &&
          m.event.text?.includes("long-cable-remote-transport-ok"),
      ),
    );
  agent.enable(false, "native_watchdog");
  await wait(() => messages.some((m) => m.type === "ended"));
  assert.equal(messages.find(m => m.type === "ended").reason, "native_watchdog");
  await wait(() => messages.some(m => m.type === "devices" && m.devices[0]?.paused === true && m.devices[0]?.inUse === false));
  assert.equal(messages.findLast(m => m.type === "devices").devices[0].pauseReason, "native_watchdog");
  assert.equal(agent.session, null);
  assert.ok(captures.some((m) => m.type === "stop"));
});
const nativeFile =
  process.env.LONG_CABLE_NATIVE_INPUT ||
  resolve(".preview/native-build/native-input.exe");
test(
  "Rust Job broker executes both shells and kills a detached owned descendant on shell completion",
  {
    skip: process.platform !== "win32" || !existsSync(nativeFile),
    timeout: 15000,
  },
  async () => {
    async function run(shell, command) {
      const spec = commandSpec(shell, command);
      const child = spawn(nativeFile, ["--job-run", spec.file, ...spec.args], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "",
        errors = "";
      child.stdout.on("data", (value) => (output += value));
      child.stderr.on("data", (value) => (errors += value));
      const code = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      assert.equal(code, 0, errors);
      return output;
    }
    assert.match(
      await run("cmd", "echo long-cable-job-cmd-ok"),
      /long-cable-job-cmd-ok/,
    );
    assert.match(
      await run("powershell", "Write-Output 'long-cable-job-powershell-ok'"),
      /long-cable-job-powershell-ok/,
    );
    const systemShell = join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const output = await run(
      "powershell",
      "$child = Start-Process -FilePath '" +
        systemShell.replaceAll("'", "''") +
        "' -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60' -WindowStyle Hidden -PassThru; $child.Id",
    );
    const pid = Number(output.trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  },
);
