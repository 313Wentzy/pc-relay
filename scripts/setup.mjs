import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";

const destination = new URL("../apps/relay/.env", import.meta.url);
try { await readFile(destination); console.error("apps/relay/.env already exists. Edit it locally; setup will not overwrite it."); process.exit(1); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const prompt = createInterface({ input: process.stdin, output: process.stdout });
try {
  console.log("PC Relay setup — create your own Supabase project and confirmed owner user first.\nNo service-role key is needed. This writes a local, Git-ignored .env file.");
  const owner = (await prompt.question("Owner email: ")).trim().toLowerCase();
  const project = (await prompt.question("Supabase project URL (https://…supabase.co): ")).trim().replace(/\/$/, "");
  const key = (await prompt.question("Supabase publishable key (sb_publishable_…): ")).trim();
  const url = new URL(project);
  if (url.protocol !== "https:" || url.origin !== project || url.username || url.password) throw Error("Use an exact HTTPS project origin.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner) || !key.startsWith("sb_publishable_") || /[\r\n\0]/.test(key)) throw Error("Check the email and publishable key.");
  const content = `# Local configuration. Never commit this file.\nRELAY_OWNER_EMAIL=${JSON.stringify(owner)}\nSUPABASE_URL=${JSON.stringify(project)}\nSUPABASE_PUBLISHABLE_KEY=${JSON.stringify(key)}\nREMOTE_RELAY_SECRET=${randomBytes(48).toString("hex")}\nREMOTE_PLATFORM_SECRET=${randomBytes(48).toString("hex")}\nPORT=8790\nHOST=127.0.0.1\nRELAY_REQUIRE_HTTPS=false\nRELAY_ALLOW_LOOPBACK_HTTP=false\n`;
  await writeFile(destination, content, { mode: 0o600, flag: "wx" });
  console.log("Saved apps/relay/.env without printing signing keys. Run npm start, then open http://127.0.0.1:8790.\nSee docs/setup.md before making the relay public.");
} finally { prompt.close(); }
