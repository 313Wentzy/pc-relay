import test from "node:test";
import assert from "node:assert/strict";
import { cloudflareTurn, iceProvider } from "./cloudflare-turn.mjs";

const issued = { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "temporary-user", credential: "temporary-secret" };
test("Cloudflare mints fresh expiring ICE credentials and keeps the API token server side", async () => {
  let calls = 0;
  const generate = cloudflareTurn({ keyId: "fixture-key", apiToken: "server-only-token", fetcher: async (url, init) => {
    calls++;
    assert.equal(url, "https://rtc.live.cloudflare.com/v1/turn/keys/fixture-key/credentials/generate-ice-servers");
    assert.equal(init.headers.Authorization, "Bearer server-only-token");
    assert.deepEqual(JSON.parse(init.body), { ttl: 86400 });
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ iceServers: [issued] }) };
  } });
  for (let i = 0; i < 2; i++) {
    const servers = await generate();
    assert.deepEqual(servers[1], issued);
    assert.doesNotMatch(JSON.stringify(servers), /server-only-token|fixture-key/);
  }
  assert.equal(calls, 2);
});
test("Cloudflare rejects incomplete server configuration without leaking configuration values", () => {
  for (const options of [{}, { keyId: "../escape", apiToken: "private" }, { keyId: "valid" }])
    assert.throws(() => cloudflareTurn(options), { message: "CLOUDFLARE_TURN_CONFIG_REQUIRED" });
});
test("upstream failures and invalid TURN responses produce only a generic client-safe error", async () => {
  for (const fetcher of [
    async () => { throw new Error("private upstream body and server-only-token"); },
    async () => ({ ok: false, json: () => { throw new Error("must not read error body"); } }),
    async () => ({ ok: true, json: async () => ({ iceServers: [] }) }),
    async () => ({ ok: true, json: async () => ({ iceServers: [{ ...issued, credential: null }] }) }),
    async () => ({ ok: true, json: async () => ({ iceServers: [{ ...issued, urls: "turns:evil.example:443?transport=tcp" }] }) }),
  ]) await assert.rejects(cloudflareTurn({ keyId: "fixture", apiToken: "private", fetcher })(), { message: "VIDEO_RELAY_UNAVAILABLE" });
});
test("normal mode never calls Cloudflare or adds relay usage; compatibility uses minted credentials", async () => {
  let calls = 0;
  const resolve = iceProvider({ CLOUDFLARE_TURN_KEY_ID: "fixture", CLOUDFLARE_TURN_API_TOKEN: "private" }, async () => {
    calls++; return { ok: true, json: async () => ({ iceServers: [issued] }) };
  });
  assert.deepEqual(await resolve("auto"), [{ urls: "stun:stun.cloudflare.com:3478" }]);
  assert.equal(calls, 0);
  assert.deepEqual((await resolve("compatibility"))[1], issued);
  assert.equal(calls, 1);
});
test("static TURN remains supported without Cloudflare", async () => {
  const servers = await iceProvider({ TURN_URLS: " turns:custom.example:443?transport=tcp , ", TURN_USERNAME: "user", TURN_CREDENTIAL: "pass" })("compatibility");
  assert.deepEqual(servers[1], { urls: ["turns:custom.example:443?transport=tcp"], username: "user", credential: "pass" });
});
