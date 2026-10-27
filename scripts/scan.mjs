import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
// Defense in depth alongside Gitleaks. Check only the exact publishable Git tree.
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
let failed = false;
for (const path of files) {
  if (/(^|\/)\.env($|\.)/.test(path) && !path.endsWith(".env.example") || /(^|\/)(identity|pairing-state|credentials)\.json$|\.(pem|key|pfx|p12|exe|zip)$/i.test(path)) { console.error("Forbidden tracked file:", path); failed = true; }
  if (/\.(png|ico)$/.test(path)) continue;
  const text = await readFile(path, "utf8");
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
    /\bAKIA[A-Z0-9]{16}\b/,
    /\bsb_secret_[A-Za-z0-9_-]{16,}\b/,
  ];
  if (patterns.some(pattern => pattern.test(text))) { console.error("Possible credential in:", path); failed = true; }
}
if (failed) process.exit(1);
console.log(`Checked ${files.length} tracked files: no forbidden state files or credential patterns. Run Gitleaks for the broader scan.`);
