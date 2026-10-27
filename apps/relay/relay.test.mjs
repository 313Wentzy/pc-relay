import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, generateKeyPairSync, sign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { WebSocket } from "ws";
import { createRelay } from "./server.mjs";
import {
  signToken,
  readToken,
  fingerprint,
  proofBody,
  validProof,
  providerOwner,
  OWNER,
  PROJECT,
} from "./auth.mjs";
import { validInput, validIceCandidate, profile, relayAddress, quantile } from "./protocol.mjs";

test("shutdown closes incomplete HTTP transports instead of waiting for the request timeout", async t => {
  const relay = createRelay({ secret: randomBytes(32).toString("hex") });
  await new Promise(resolve => relay.server.listen(0, "127.0.0.1", resolve));
  const idle = createConnection({ host: "127.0.0.1", port: relay.server.address().port });
  t.after(() => idle.destroy());
  await new Promise(resolve => idle.once("connect", resolve));
  idle.write("GET /healthz HTTP/1.1\r\nHost: localhost\r\n");
  let timeout;
  try {
    await Promise.race([relay.close(), new Promise((_, reject) => { timeout = setTimeout(() => reject(Error("SHUTDOWN_TIMEOUT")), 1000); })]);
  } finally { clearTimeout(timeout); }
  assert.equal(relay.server.listening, false);
});

test("Heroku redirects HTTP to the configured HTTPS origin and rejects insecure WebSocket upgrades", async (t) => {
  const secret = randomBytes(32).toString("hex");
  const publicOrigin = "https://long-cable-relay-fixture.herokuapp.com";
  assert.throws(() => createRelay({ secret, requireHttps: true }), /PUBLIC_RELAY_ORIGIN_REQUIRED/);
  const relay = createRelay({ secret, requireHttps: true, publicOrigin });
  await new Promise(resolve => relay.server.listen(0, "127.0.0.1", resolve));
  t.after(() => relay.close());
  const base = "http://127.0.0.1:" + relay.server.address().port;
  for (const proto of [undefined, "http", "https,http"]) {
    const response = await fetch(base + "/console?from=phone", { redirect: "manual", headers: proto ? { "X-Forwarded-Proto": proto } : {} });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), publicOrigin + "/console?from=phone");
  }
  const secure = await fetch(base + "/healthz", { headers: { "X-Forwarded-Proto": "https" } });
  assert.equal(secure.status, 200);
  assert.equal(secure.headers.get("strict-transport-security"), "max-age=86400");
  assert.equal((await secure.json()).service, "long-cable-pc-relay");
  const insecure = new WebSocket(base.replace(/^http/, "ws") + "/connect");
  await assert.rejects(new Promise((resolve, reject) => { insecure.once("open", resolve); insecure.once("error", reject); }), /403/);
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/connect", { origin: base.replace(/^http/, "https"), headers: { "X-Forwarded-Proto": "https" } });
  t.after(() => ws.close());
  const challenge = await new Promise((resolve, reject) => { ws.once("message", data => resolve(JSON.parse(data))); ws.once("error", reject); });
  assert.equal(challenge.type, "challenge");
});

export async function connection(base, origin) {
  const ws = new WebSocket(
    base.replace(/^http/, "ws") + "/connect",
    origin ? { origin } : {},
  );
  const messages = [],
    waiters = [];
  ws.on("message", (raw) => {
    const value = JSON.parse(raw.toString());
    const index = waiters.findIndex((w) => w.predicate(value));
    if (index >= 0) {
      const waiter = waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    } else messages.push(value);
  });
  ws.on("error", () => {});
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const next = (predicate) =>
    new Promise((resolve, reject) => {
      const match =
        typeof predicate === "string"
          ? (value) => value.type === predicate
          : predicate;
      const index = messages.findIndex(match);
      if (index >= 0) {
        resolve(messages.splice(index, 1)[0]);
        return;
      }
      const waiter = {
        predicate: match,
        resolve,
        timer: setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error("TIMEOUT waiting " + predicate));
        }, 6000),
      };
      waiters.push(waiter);
    });
  return {
    ws,
    send: (value) => ws.send(JSON.stringify(value)),
    next,
    messages,
  };
}
test("temporary tunnel HTTPS mode preserves direct local agents but rejects forwarded HTTP and foreign hosts", async (t) => {
  const publicOrigin = "https://fixture.trycloudflare.com";
  const relay = createRelay({ secret: randomBytes(32).toString("hex"), requireHttps: true, allowLoopbackHttp: true, publicOrigin });
  await new Promise(resolve => relay.server.listen(0, "127.0.0.1", resolve));
  t.after(() => relay.close());
  const base = "http://127.0.0.1:" + relay.server.address().port;
  assert.equal((await fetch(base + "/healthz")).status, 200);
  for (const headers of [{ "X-Forwarded-Proto": "http" }, { Host: "fixture.trycloudflare.com" }, { "CF-Connecting-IP": "192.0.2.1" }, { "X-Forwarded-For": "192.0.2.1" }, { Forwarded: "proto=http" }]) {
    // Node fetch normalizes Host. Use the HTTP client to actually send the
    // hostile host rather than accidentally testing another loopback request.
    const response = await new Promise((resolve, reject) => {
      const req = httpRequest(base + "/console", { headers }, res => {
        res.resume();
        res.once("end", () => resolve({ status: res.statusCode, location: res.headers.location }));
      });
      req.once("error", reject); req.end();
    });
    assert.equal(response.status, 308, JSON.stringify(headers));
    assert.equal(response.location, publicOrigin + "/console");
  }
  const agent = await connection(base);
  t.after(() => agent.ws.close());
  assert.equal((await agent.next("challenge")).type, "challenge");
  agent.send({ type: "list" });
  assert.equal((await agent.next("error")).error, "AUTH_REQUIRED");
});
export async function fixture(t, options = {}) {
  const secret = randomBytes(32).toString("hex"),
    token = randomBytes(24).toString("hex"),
    trustExpiresAt = Date.now() + 86400000;
  const relay = createRelay({
    browserOrigins: ["https://console.example.com", "https://other.example.com"],
    ...options,
    secret,
    authenticate: async (value) => {
      if (value !== token) throw new Error("AUTH_REQUIRED");
      return {
        ownerId: "synthetic-owner",
        sessionId: "synthetic-session",
        trustExpiresAt,
        expiresAt: Date.now() + 3600000,
      };
    },
  });
  await new Promise((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + relay.server.address().port;
  t.after(() => relay.close());
  return { relay, secret, token, base };
}
test("signed credentials separate purposes, bind time, and reject tampering and wrong proof", () => {
  const secret = "a".repeat(64),
    token = signToken(secret, "browser", { issuedAt: 1000, expiresAt: 2000 });
  assert.equal(readToken(secret, "browser", token, 1500).purpose, "browser");
  for (const [purpose, value, now] of [
    ["agent", token, 1500],
    ["browser", token + "x", 1500],
    ["browser", token, 2000],
    ["browser", token, 999],
  ])
    assert.throws(() => readToken(secret, purpose, value, now));
  const pair = generateKeyPairSync("ed25519"),
    pub = pair.publicKey.export({ type: "spki", format: "pem" });
  const signature = sign(
    null,
    Buffer.from(proofBody("nonce-a", token)),
    pair.privateKey,
  ).toString("base64url");
  assert.ok(validProof(pub, "nonce-a", token, signature));
  assert.equal(validProof(pub, "nonce-b", token, signature), false);
  assert.equal(fingerprint(pub).length, 64);
});
test("owner authentication validates the exact token remotely before trusting MFA claims", async () => {
  const now = 1800000000000,
    user = {
      id: "owner",
      email: OWNER,
      email_confirmed_at: "yes",
      factors: [{ factor_type: "totp", status: "verified" }],
    };
  const claims = {
    sub: user.id,
    session_id: "s",
    role: "authenticated",
    iss: PROJECT + "/auth/v1",
    aal: "aal2",
    amr: [{ method: "totp", timestamp: now / 1000 - 30 }],
    exp: now / 1000 + 60,
    iat: now / 1000 - 60,
  };
  const token = (value) =>
    "synthetic." +
    Buffer.from(JSON.stringify(value)).toString("base64url") +
    ".test";
  let checked;
  const fetcher = async (url, init) => {
    checked = init.headers.Authorization;
    assert.equal(url, PROJECT + "/auth/v1/user");
    return { ok: true, json: async () => user };
  };
  const result = await providerOwner(
    token(claims),
    "sb_publishable_fixture",
    now,
    fetcher,
  );
  assert.equal(checked, "Bearer " + token(claims));
  assert.equal(result.ownerId, user.id);
  await assert.rejects(
    providerOwner(
      token({ ...claims, aal: "aal1" }),
      "sb_publishable_fixture",
      now,
      fetcher,
    ),
    /OWNER_MFA_REQUIRED/,
  );
  await assert.rejects(
    providerOwner(
      token({
        ...claims,
        amr: [{ method: "totp", timestamp: now / 1000 - 86401 }],
      }),
      "sb_publishable_fixture",
      now,
      fetcher,
    ),
    /OWNER_MFA_REQUIRED/,
  );
  await assert.rejects(
    providerOwner(token(claims), "sb_publishable_fixture", now, async () => ({
      ok: false,
    })),
    /AUTH_REQUIRED/,
  );
});
test("input and focus profiles validate bounded data and report no invented latency", () => {
  assert.ok(validInput({ kind: "move", x: 0, y: 1 }));
  assert.ok(validInput({ kind: "release" }));
  assert.equal(validInput({ kind: "move", x: 2, y: 0 }), false);
  assert.equal(validInput({ kind: "keydown", code: "RunProgram" }), false);
  assert.equal(validInput({ kind: "release", admin: true }), false);
  assert.equal(profile(true).maxFramerate, 60);
  assert.equal(profile(false).maxFramerate, 5);
  assert.equal(profile(true, 30).maxFramerate, 30);
  const candidate = { candidate: "candidate:fixture", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "fixture" };
  assert.equal(validIceCandidate(candidate), true);
  for (const value of [null, {}, { ...candidate, candidate: "x".repeat(3000) }, { ...candidate, sdpMLineIndex: 99 }, { ...candidate, secret: "not-allowed" }]) assert.ok(!validIceCandidate(value));
  assert.equal(quantile([], 0.99), null);
  assert.equal(quantile([3, 1, 2], 0.5), 2);
  assert.equal(
    relayAddress("https://test.herokuapp.com"),
    "https://test.herokuapp.com",
  );
  for (const url of [
    "http://internet.example",
    "https://user:pass@test.example",
    "https://test.example/path",
    "https://test.example/?token=secret",
  ])
    assert.throws(() => relayAddress(url));
});
for (const transport of ["auto", "compatibility"]) {
test(`${transport}: real sockets pair, reject stale input, carry command output, and fence takeover`, async (t) => {
  // fixture's synthetic token is not an environment flag or deployed bypass.
  const iceServers = [{ urls: ["turn:fixture.example:3478?transport=udp", "turns:fixture.example:443?transport=tcp"], username: "fixture", credential: "fixture" }];
  const setup = await fixture(t, { iceServers });
  const browser = await connection(setup.base, setup.base);
  await browser.next("challenge");
  browser.send({ type: "auth", accessToken: setup.token });
  await browser.next("ready");
  browser.send({ type: "pair-start" });
  const pending = await browser.next("pair-code");
  const pair = generateKeyPairSync("ed25519"),
    publicKey = pair.publicKey.export({ type: "spki", format: "pem" });
  const agent = await connection(setup.base),
    challenge = await agent.next("challenge");
  agent.send({
    type: "pair-join",
    code: pending.code,
    publicKey,
    name: "Synthetic PC",
    signature: sign(
      null,
      Buffer.from(proofBody(challenge.nonce, pending.code)),
      pair.privateKey,
    ).toString("base64url"),
  });
  const review = await browser.next("pair-review");
  await agent.next("pair-waiting");
  browser.send({
    type: "pair-approve",
    code: pending.code,
    fingerprint: "wrong",
  });
  assert.equal((await browser.next("error")).error, "INVALID_PAIRING");
  browser.send({
    type: "pair-approve",
    code: pending.code,
    fingerprint: review.fingerprint,
  });
  const paired = await agent.next("paired");
  await browser.next("pair-complete");
  agent.ws.close();
  const linked = await connection(setup.base),
    proof = await linked.next("challenge");
  linked.send({
    type: "agent-auth",
    certificate: paired.certificate,
    signature: sign(
      null,
      Buffer.from(proofBody(proof.nonce, paired.certificate)),
      pair.privateKey,
    ).toString("base64url"),
  });
  await linked.next("agent-ready");
  linked.send({
    type: "agent-status",
    blocked: false,
    elevated: false,
    capabilities: { clipboard: true, windows: true },
    screens: [
      { id: "screen-1", label: "Screen 1", width: 1920, height: 1080 },
      { id: "screen-2", label: "Screen 2", width: 1920, height: 1080 },
    ],
  });
  await browser.next((m) => m.type === "devices" && m.devices[0]?.available);
  browser.send({ type: "start", deviceId: review.fingerprint, screenIds: ["screen-1"], transport: "invalid" });
  assert.equal((await browser.next("error")).error, "INVALID_VIDEO_TRANSPORT");
  assert.equal(setup.relay.agents.get(review.fingerprint).session, null);
  browser.send({ type: "start", deviceId: review.fingerprint, screenIds: ["screen-1"], audio: "yes" });
  assert.equal((await browser.next("error")).error, "INVALID_AUDIO_OPTION");
  browser.send({
    type: "start",
    deviceId: review.fingerprint,
    screenIds: ["screen-1", "screen-2"],
    fps: 60,
    transport,
    audio: true,
  });
  const session = await browser.next("started");
  const agentSession = await linked.next("started");
  assert.deepEqual(agentSession, session);
  assert.equal(session.audio, true);
  const secondBrowser = await connection(setup.base, setup.base);
  t.after(() => secondBrowser.ws.close());
  await secondBrowser.next("challenge");
  secondBrowser.send({ type: "auth", accessToken: setup.token });
  await secondBrowser.next("ready");
  const secondList = await secondBrowser.next("devices");
  assert.equal(secondList.devices[0].inUse, true);
  secondBrowser.send({ type: "start", deviceId: review.fingerprint, screenIds: ["screen-1"] });
  assert.equal((await secondBrowser.next("error")).error, "ALREADY_CONTROLLED");
  assert.equal(setup.relay.agents.get(review.fingerprint).session.id, session.sessionId);
  secondBrowser.ws.close();
  const candidate = { candidate: "candidate:fixture", sdpMid: "0", sdpMLineIndex: 0 };
  browser.send({ type: "ice", sessionId: session.sessionId, candidate });
  assert.deepEqual((await linked.next("ice")).candidate, candidate);
  linked.send({ type: "ice", sessionId: session.sessionId, candidate });
  assert.deepEqual((await browser.next("ice")).candidate, candidate);
  const activity = setup.relay.agents.get(review.fingerprint).session.activity;
  browser.send({ type: "visibility", sessionId: session.sessionId, screenIds: ["screen-2"] });
  assert.deepEqual((await linked.next("visibility")).screenIds, ["screen-2"]);
  assert.equal(setup.relay.agents.get(review.fingerprint).session.activity, activity);
  browser.send({ type: "visibility", sessionId: session.sessionId, screenIds: ["outside-lease"] });
  assert.equal((await browser.next("error")).error, "INVALID_SCREENS");
  browser.send({ type: "visibility", sessionId: session.sessionId, screenIds: [] });
  assert.deepEqual((await linked.next("visibility")).screenIds, []);
  assert.equal(session.iceTransportPolicy, transport === "compatibility" ? "relay" : "all");
  assert.deepEqual(session.iceServers[0].urls, transport === "compatibility" ? ["turns:fixture.example:443?transport=tcp"] : iceServers[0].urls);
  browser.send({ type: "probe", sessionId: session.sessionId, id: "probe-1" });
  const probe = await linked.next("probe");
  linked.send({
    type: "probe-ack",
    sessionId: session.sessionId,
    id: probe.id,
  });
  await browser.next("probe-ack");
  browser.send({
    type: "input",
    sessionId: session.sessionId,
    sequence: 1,
    screenId: "screen-2",
    input: { kind: "move", x: 0.5, y: 0.5 },
  });
  await linked.next("input");
  linked.send({ type: "input-ack", sessionId: session.sessionId, sequence: 1 });
  await browser.next("input-ack");
  browser.send({
    type: "input",
    sessionId: session.sessionId,
    sequence: 1,
    screenId: "screen-2",
    input: { kind: "move", x: 0.5, y: 0.5 },
  });
  assert.equal((await browser.next("error")).error, "INVALID_INPUT");
  const live = setup.relay.agents.get(review.fingerprint).session;
  browser.send({ type: "direct-input-ack", sessionId: session.sessionId, sequence: 2, screenId: "screen-1" });
  assert.equal((await browser.next("error")).error, "INVALID_MESSAGE");
  assert.equal(live.sequence, 1);
  linked.send({ type: "direct-input-ack", sessionId: session.sessionId, sequence: 2, screenId: "outside-scope" });
  linked.send({ type: "ping", id: "direct-invalid" }); await linked.next("pong");
  assert.equal(live.sequence, 1);
  linked.send({ type: "direct-input-ack", sessionId: session.sessionId, sequence: 2, screenId: "screen-1" });
  linked.send({ type: "ping", id: "direct-valid" }); await linked.next("pong");
  assert.equal(live.sequence, 2);
  linked.send({ type: "direct-input-ack", sessionId: session.sessionId, sequence: 1, screenId: "screen-1" });
  linked.send({ type: "ping", id: "direct-replay" }); await linked.next("pong");
  assert.equal(live.sequence, 2);
  browser.send({ type: "clipboard", sessionId: session.sessionId, screenId: "outside-scope", sequence: 3, requestId: "paste-1", text: "Fixture clipboard", paste: true });
  assert.equal((await browser.next("error")).error, "INVALID_CLIPBOARD");
  browser.send({ type: "clipboard", sessionId: session.sessionId, screenId: "screen-2", sequence: 3, requestId: "paste-1", text: "Fixture clipboard", paste: true });
  const clipboard = await linked.next("clipboard");
  assert.equal(clipboard.text, "Fixture clipboard");
  linked.send({ type: "clipboard-result", sessionId: session.sessionId, requestId: "paste-1", ok: true });
  assert.deepEqual(await browser.next("clipboard-result"), { type: "clipboard-result", sessionId: session.sessionId, requestId: "paste-1", ok: true });
  browser.send({
    type: "command",
    sessionId: session.sessionId,
    requestId: "test-command",
    shell: "powershell",
    command: "Get-Date",
    admin: false,
  });
  await linked.next("command");
  linked.send({
    type: "command-event",
    sessionId: session.sessionId,
    requestId: "test-command",
    event: { type: "output", text: "fixture output" },
  });
  assert.equal(
    (await browser.next("command-event")).event.text,
    "fixture output",
  );
  linked.send({
    type: "command-event",
    sessionId: session.sessionId,
    requestId: "test-command",
    event: { type: "exit", code: 0, reason: "completed" },
  });
  await browser.next("command-event");
  linked.send({
    type: "agent-status",
    blocked: true,
    elevated: false,
    screens: [],
  });
  assert.equal((await browser.next("ended")).reason, "local_takeover");
  browser.send({ type: "probe", sessionId: session.sessionId, id: "stale" });
  assert.equal((await browser.next("error")).error, "NO_SESSION");
  assert.equal(
    (await fetch(setup.base + "/ping?nonce=test").then((r) => r.json())).nonce,
    "test",
  );
});
}
test("foreign origins and unauthenticated control cannot enter the relay", async (t) => {
  const { base } = await fixture(t);
  await assert.rejects(connection(base, "https://evil.example"), /Unexpected server response: 403/);
  const client = await connection(base);
  await client.next("challenge");
  client.send({ type: "start", deviceId: "any", screenIds: ["1"] });
  assert.equal((await client.next("error")).error, "AUTH_REQUIRED");
});

for (const scenario of ["provider failure", "local takeover", "browser disconnect"]) {
test(`async TURN credential issuance preserves fencing on ${scenario}`, async t => {
  let release, requested;
  const requestedPromise = new Promise(resolve => { requested = resolve; });
  const pendingIce = new Promise(resolve => { release = resolve; });
  const setup = await fixture(t, { resolveIceServers: async () => {
    requested();
    await pendingIce;
    if (scenario === "provider failure") throw new Error("VIDEO_RELAY_UNAVAILABLE");
    return [{ urls: "turns:fixture.example:443?transport=tcp", username: "fixture", credential: "temporary" }];
  } });
  const browser = await connection(setup.base, setup.base);
  await browser.next("challenge");
  browser.send({ type: "auth", accessToken: setup.token });
  await browser.next("ready");
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const deviceId = fingerprint(publicKey);
  const certificate = signToken(setup.secret, "agent", { ownerId: "synthetic-owner", deviceId, publicKey, name: "Fixture", issuedAt: Date.now(), expiresAt: Date.now() + 86400000 });
  const agent = await connection(setup.base);
  const challenge = await agent.next("challenge");
  agent.send({ type: "agent-auth", certificate, signature: sign(null, Buffer.from(proofBody(challenge.nonce, certificate)), keys.privateKey).toString("base64url") });
  await agent.next("agent-ready");
  const screens = [{ id: "one", label: "One", width: 1280, height: 720 }];
  agent.send({ type: "agent-status", blocked: false, screens });
  await browser.next(m => m.type === "devices" && m.devices[0]?.available);
  browser.send({ type: "start", deviceId, screenIds: ["one"], transport: "compatibility" });
  await requestedPromise;
  if (scenario === "local takeover") {
    browser.messages.splice(0);
    agent.send({ type: "agent-status", blocked: true, screens });
    await browser.next(m => m.type === "devices" && m.devices[0]?.paused);
  }
  if (scenario === "browser disconnect") {
    const closed = new Promise(resolve => browser.ws.once("close", resolve));
    browser.ws.close(); await closed;
  }
  release();
  if (scenario !== "browser disconnect")
    assert.equal((await browser.next("error")).error, scenario === "provider failure" ? "VIDEO_RELAY_UNAVAILABLE" : "PC_UNAVAILABLE");
  // Let credential resolution finish before checking that it created no lease.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(setup.relay.agents.get(deviceId).session, null);
  assert.equal(agent.messages.some(message => message.type === "started"), false);
});
}

test("platform tickets tolerate small issuance clock skew without extending expiry or MFA trust", async t => {
  const secret = randomBytes(32).toString("hex"), now = Date.now();
  const relay = createRelay({ secret, clock: () => now });
  await new Promise(resolve => relay.server.listen(0, "127.0.0.1", resolve));
  t.after(() => relay.close());
  const base = "http://127.0.0.1:" + relay.server.address().port, origin = "https://console.example.com";
  const claims = { ownerId: "fixture-owner", email: OWNER, sessionId: "fixture-session", origin,
    issuedAt: now + 1000, expiresAt: now + 45000, trustExpiresAt: now + 86400000 };
  for (const [override, expected] of [
    [{}, "ready"],
    [{ issuedAt: now + 5001 }, "TOKEN_EXPIRED"],
    [{ issuedAt: now - 45000, expiresAt: now }, "TOKEN_EXPIRED"],
    [{ trustExpiresAt: now }, "AUTH_REQUIRED"],
  ]) {
    const browser = await connection(base, origin);
    t.after(() => browser.ws.close());
    await browser.next("challenge");
    browser.send({ type: "auth", ticket: signToken(secret, "browser", { ...claims, ...override, nonce: randomBytes(16).toString("hex") }) });
    const message = await browser.next(value => value.type === "ready" || value.type === "error");
    assert.equal(message.type === "ready" ? "ready" : message.error, expected);
  }
  // Certificate and other token callers retain their original strict check.
  assert.throws(() => readToken(secret, "agent", signToken(secret, "agent", claims), now), /TOKEN_EXPIRED/);
});

test("embedded platform tickets are single use, origin bound, and use a separate key from PC certificates", async (t) => {
  const secret = randomBytes(32).toString("hex"), platformSecret = randomBytes(32).toString("hex");
  const relay = createRelay({ browserOrigins: ["https://console.example.com"], secret, platformSecret });
  await new Promise(resolve => relay.server.listen(0, "127.0.0.1", resolve));
  t.after(() => relay.close());
  const base = "http://127.0.0.1:" + relay.server.address().port;
  const origin = "https://console.example.com", now = Date.now();
  const claims = {
    ownerId: "fixture-owner", email: OWNER, sessionId: "fixture-session", origin,
    issuedAt: now, expiresAt: now + 45000, trustExpiresAt: now + 86400000,
  };
  for (const [key, claimOrigin] of [[secret, origin], [platformSecret, "https://other.example.com"]]) {
    const denied = await connection(base, origin);
    t.after(() => denied.ws.close());
    await denied.next("challenge");
    denied.send({ type: "auth", ticket: signToken(key, "browser", { ...claims, origin: claimOrigin, nonce: randomBytes(16).toString("hex") }) });
    await denied.next("error");
  }
  const ticket = signToken(platformSecret, "browser", { ...claims, nonce: randomBytes(16).toString("hex") });
  const browser = await connection(base, origin);
  t.after(() => browser.ws.close());
  await browser.next("challenge");
  browser.send({ type: "auth", ticket });
  await browser.next("ready");
  const otherDevice = await connection(base, origin);
  t.after(() => otherDevice.ws.close());
  await otherDevice.next("challenge");
  otherDevice.send({ type: "auth", ticket: signToken(platformSecret, "browser", { ...claims,
    sessionId: "different-provider-session", trustExpiresAt: claims.trustExpiresAt - 1000, nonce: randomBytes(16).toString("hex") }) });
  await otherDevice.next("ready");
  // Independent owner devices retain their own provider session and MFA deadline.
  browser.send({ type: "ping", id: "first-still-connected" });
  assert.equal((await browser.next("pong")).id, "first-still-connected");
  const replay = await connection(base, origin);
  t.after(() => replay.ws.close());
  await replay.next("challenge");
  replay.send({ type: "auth", ticket });
  assert.equal((await replay.next("error")).error, "AUTH_REQUIRED");
  const renewed = signToken(platformSecret, "browser", { ...claims, nonce: randomBytes(16).toString("hex") });
  browser.send({ type: "reauth", ticket: renewed });
  await browser.next("ready");
  browser.send({ type: "list" });
  await browser.next("devices");
});
