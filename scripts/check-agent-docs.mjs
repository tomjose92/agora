import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const docs = fs.readFileSync(
  path.join(root, "web/public/docs/coding-agents/guide-data.js"),
  "utf8",
);
const agents = ["codex-cli", "cursor-cli", "claude-cli"];
let failed = false;

for (const agent of agents) {
  const source = fs.readFileSync(path.join(root, "bridges", agent, "bridge.py"), "utf8");
  const variables = new Set(
    [...source.matchAll(/os\.environ\.get\("([A-Z0-9_]+)"/g)].map(match => match[1]),
  );
  const missing = [...variables].filter(variable => !docs.includes(`"${variable}"`));
  if (missing.length) {
    failed = true;
    console.error(`${agent}: undocumented environment variables: ${missing.join(", ")}`);
  } else {
    console.log(`${agent}: ${variables.size} environment variables documented`);
  }
}

if (failed) process.exit(1);
