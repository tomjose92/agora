import fs from "node:fs";
import path from "node:path";
import { guides, sharedEnv } from "../web/public/docs/coding-agents/guide-data.js";

const root = path.resolve(import.meta.dirname, "..");
const agents = {
  "codex-cli": "codex",
  "cursor-cli": "cursor",
  "claude-cli": "claude",
};
const sharedVariables = sharedEnv.map(([name]) => name);
const envRead = /os\.(?:environ\.get|getenv)\(\s*(["'])([A-Z0-9_]+)\1/g;
let failed = false;

for (const [directory, guideKey] of Object.entries(agents)) {
  const source = fs.readFileSync(path.join(root, "bridges", directory, "bridge.py"), "utf8");
  const implemented = new Set([...source.matchAll(envRead)].map(match => match[2]));
  const documented = new Set([
    ...sharedVariables,
    ...guides[guideKey].env.map(([name]) => name),
  ]);
  const missing = [...implemented].filter(variable => !documented.has(variable));
  const stale = [...documented].filter(variable => !implemented.has(variable));

  if (missing.length || stale.length) {
    failed = true;
    if (missing.length) {
      console.error(`${directory}: undocumented environment variables: ${missing.join(", ")}`);
    }
    if (stale.length) {
      console.error(`${directory}: documented but unused environment variables: ${stale.join(", ")}`);
    }
  } else {
    console.log(`${directory}: ${implemented.size} environment variables documented exactly`);
  }
}

if (failed) process.exit(1);
