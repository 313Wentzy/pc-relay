import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".git", ".preview", "dist"].includes(entry.name)) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await walk(path);
    else if (/\.(mjs|cjs|js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
}
await walk("."); console.log("JavaScript syntax checks passed.");
