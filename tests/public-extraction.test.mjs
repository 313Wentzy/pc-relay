import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createDemo } from "../scripts/demo.mjs";
import { createRelay } from "../apps/relay/server.mjs";

test("public demo is isolated from authentication and real PC endpoints", async t => {
  const server = createDemo();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /SIMULATION · NO REAL PC/);
  assert.match(response.headers.get("content-security-policy"), /connect-src 'none'/);
  for (const path of ["/connect", "/config", "/.env", "/console", "/../package.json"]) assert.equal((await fetch(base + path)).status, 404, path);
  for (const path of ["/demo.mjs", "/demo.css"]) assert.equal((await fetch(base + path)).status, 200);
});

test("relay uses the installer's configured auth project and owner", async t => {
  const relay = createRelay({ secret: randomBytes(48).toString("hex"), publishableKey: "sb_publishable_test_fixture" });
  await new Promise(resolve => relay.server.listen(0, "127.0.0.1", resolve));
  t.after(() => relay.close());
  const base = "http://127.0.0.1:" + relay.server.address().port;
  const response = await fetch(base + "/config");
  assert.deepEqual(await response.json(), { project: "https://example.supabase.co", publishableKey: "sb_publishable_test_fixture", owner: "owner@example.com" });
  const console = await fetch(base + "/console");
  assert.match(console.headers.get("content-security-policy"), /connect-src 'self' https:\/\/example.supabase.co;/);
  assert.match(await console.text(), /id="mfa-enrollment" hidden/);
  assert.equal((await fetch(base + "/.env")).status, 404);
  assert.equal((await fetch(base + "/demo")).status, 200);
});

test("relay startup fails closed for missing or unsafe auth configuration", () => {
  for (const overrides of [
    { SUPABASE_URL: "" }, { SUPABASE_URL: "https://project.example.com/path" },
    { SUPABASE_URL: "http://project.example.com" }, { RELAY_OWNER_EMAIL: "" }, { SUPABASE_PUBLISHABLE_KEY: "" },
  ]) {
    const result = spawnSync(process.execPath, ["apps/relay/server.mjs"], { encoding: "utf8", timeout: 5000, env: {
      ...process.env, RELAY_OWNER_EMAIL: "owner@example.com", SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_fixture", REMOTE_RELAY_SECRET: randomBytes(48).toString("hex"), ...overrides,
    } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SUPABASE_|RELAY_OWNER_EMAIL_REQUIRED/);
  }
});
