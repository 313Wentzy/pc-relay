import { defineConfig } from "@playwright/test";
process.env.RELAY_OWNER_EMAIL = "owner@example.com";
process.env.SUPABASE_URL = "https://example.supabase.co";
export default defineConfig({ testDir: "./tests", testMatch: "*.spec.mjs", workers: 1, timeout: 15000, use: { browserName: "chromium", headless: true }, reporter: "list" });
