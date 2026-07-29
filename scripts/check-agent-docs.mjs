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
const envRead = /os\.(?:environ\.get|getenv)\(\s*(["'])([A-Z0-9_]+)\1(?:\s*,\s*(["'])(.*?)\3)?/g;
const indexedEnvRead = /os\.environ\s*\[\s*(["'])([A-Z0-9_]+)\1\s*\]/g;
const ignoredLiteralDefaults = new Set([
  "AGORA_PAIRING_TOKEN", "AGENT_ID", "AGENT_NAME", "AGENT_AVATAR", "STATE_FILE",
]);
const displayedDefault = value => {
  const normalized = value.replace(/^Empty(?: \(.*\))?$/, "");
  return normalized === "—" ? null : normalized;
};
let failed = false;

for (const [directory, guideKey] of Object.entries(agents)) {
  const source = fs.readFileSync(path.join(root, "bridges", directory, "bridge.py"), "utf8");
  const reads = [...source.matchAll(envRead)];
  const indexedReads = [...source.matchAll(indexedEnvRead)];
  const implemented = new Set([
    ...reads.map(match => match[2]),
    ...indexedReads.map(match => match[2]),
  ]);
  const documentedRows = [...sharedEnv, ...guides[guideKey].env];
  const documented = new Set(documentedRows.map(([name]) => name));
  const missing = [...implemented].filter(variable => !documented.has(variable));
  const stale = [...documented].filter(variable => !implemented.has(variable));
  const invalidRequirements = documentedRows
    .filter(([, requirement]) => !["Required", "Required*", "Recommended", "Optional"].includes(requirement))
    .map(([name]) => name);
  const documentedDefaults = new Map(
    documentedRows.map(([name, , fallback]) => [name, displayedDefault(fallback)]),
  );
  const wrongDefaults = reads.flatMap(match => {
    const [, , variable, , literalDefault] = match;
    if (literalDefault === undefined || ignoredLiteralDefaults.has(variable)) return [];
    const documentedDefault = documentedDefaults.get(variable);
    const followingSource = source.slice(match.index + match[0].length, match.index + match[0].length + 80);
    const booleanFromEmpty = literalDefault === ""
      && /^\s*\)\.lower\(\)\s+in\s+\(/.test(followingSource);
    const effectiveDefault = booleanFromEmpty ? "0" : literalDefault;
    return documentedDefault === effectiveDefault
      ? []
      : [`${variable} (code: ${JSON.stringify(effectiveDefault)}, guide: ${JSON.stringify(documentedDefault)})`];
  });

  if (missing.length || stale.length || invalidRequirements.length || wrongDefaults.length) {
    failed = true;
    if (missing.length) {
      console.error(`${directory}: undocumented environment variables: ${missing.join(", ")}`);
    }
    if (stale.length) {
      console.error(`${directory}: documented but unused environment variables: ${stale.join(", ")}`);
    }
    if (invalidRequirements.length) {
      console.error(`${directory}: invalid requirement labels: ${invalidRequirements.join(", ")}`);
    }
    if (wrongDefaults.length) {
      console.error(`${directory}: documented defaults differ from code: ${wrongDefaults.join(", ")}`);
    }
  } else {
    console.log(`${directory}: ${implemented.size} environment variables and literal defaults documented exactly`);
  }
}

if (failed) process.exit(1);
