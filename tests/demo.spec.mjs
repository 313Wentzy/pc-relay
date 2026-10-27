import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { createDemo } from "../scripts/demo.mjs";
import { createRelay } from "../apps/relay/server.mjs";
let demo, relay, demoUrl, relayUrl;
test.beforeAll(async () => {
  demo = createDemo();
  relay = createRelay({ secret: randomBytes(48).toString("hex"), publishableKey: "sb_publishable_browser_fixture" });
  await Promise.all([new Promise(resolve => demo.listen(0, "127.0.0.1", resolve)), new Promise(resolve => relay.server.listen(0, "127.0.0.1", resolve))]);
  demoUrl = "http://127.0.0.1:" + demo.address().port;
  relayUrl = "http://127.0.0.1:" + relay.server.address().port;
});
test.afterAll(async () => { await Promise.all([new Promise(resolve => demo.close(resolve)), relay.close()]); });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`demo works at ${viewport.width}px without connecting to a PC`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const errors = [], connections = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("websocket", ws => connections.push(ws.url()));
    await page.goto(demoUrl);
    await expect(page.getByText("SIMULATION · NO REAL PC")).toBeVisible();
    await page.getByRole("button", { name: "Connect demo" }).click();
    await expect(page.locator("#notes-window")).toBeVisible();
    await page.locator("#notes").fill("My browser-only note");
    await page.locator("#open-terminal").click();
    await page.locator("#command").fill("whoami");
    await page.locator("#command").press("Enter");
    await expect(page.locator("#terminal-output")).toContainText("demo-visitor (browser simulation)");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (viewport.width === 1440) await page.screenshot({ path: "test-results/demo-desktop.png", fullPage: true });
    else await page.screenshot({ path: "test-results/demo-mobile.png", fullPage: true });
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.locator("#offline")).toBeVisible();
    await expect(page.locator("#notes")).not.toHaveValue("My browser-only note");
    expect(errors).toEqual([]); expect(connections).toEqual([]);
  });
}
test("fresh owner can reach authenticator enrollment with a synthetic provider", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://example.supabase.co/auth/v1/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const response = path.endsWith("/user") ? { email: "owner@example.com", factors: [] }
      : path.endsWith("/factors") ? { id: "fixture-factor", totp: { secret: "SYNTHETIC-SETUP-KEY" } }
      : { access_token: "synthetic-access", refresh_token: "synthetic-refresh" };
    await route.fulfill({ json: response, headers: { "Access-Control-Allow-Origin": relayUrl } });
  });
  await page.goto(relayUrl + "/console");
  await expect(page.locator("#owner")).toHaveText("owner@example.com");
  await page.locator("#password").fill("synthetic-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#mfa-enrollment")).toBeVisible();
  await expect(page.locator("#mfa-secret")).toHaveText("SYNTHETIC-SETUP-KEY");
  await expect(page.locator("#mfa-form")).toBeVisible();
  await expect(page.locator("#password")).toHaveValue("");
  expect(errors).toEqual([]);
});
