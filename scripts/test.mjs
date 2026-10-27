import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
const directories = ["apps/relay", "apps/desktop-agent", "tests"];
const files = [];
for (const directory of directories) for (const file of await readdir(directory)) if (file.endsWith(".test.mjs")) files.push(`${directory}/${file}`);
const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit", env: { ...process.env, RELAY_OWNER_EMAIL: "owner@example.com", SUPABASE_URL: "https://example.supabase.co", RELAY_BROWSER_ORIGINS: "https://console.example.com,https://other.example.com" },
});
process.exit(result.status ?? 1);
