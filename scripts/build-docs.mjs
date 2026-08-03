#!/usr/bin/env node
// Renders docs/*.md into a small static docs site (landing page + guide
// pages + shared chrome), unified with the coding-agent guides that live at
// web/public/docs/coding-agents/.
//
// Used in two places, producing identical output:
//   - the web build (web/package.json) emits into web/dist/docs, so the
//     headless server, the Docker image, and the desktop bundle all serve
//     the docs at /docs/ (the coding-agent guides arrive there via Vite's
//     public-dir copy);
//   - the GitHub Pages workflow emits into _site/docs (and copies the
//     coding-agent guides in), published at
//     https://tomjose92.github.io/agora/docs/.
//
// Layout follows the Pantheo docs (topbar + search, grouped sidebar, prose
// column, "On this page" rail, prev/next pager); design tokens mirror
// web/public/docs/coding-agents/guide.css so both doc sets read as one site.
//
// The two hosts differ in shape: on a server the app owns /, so the docs
// live under /docs/; on GitHub Pages the docs landing IS the site root and
// hosts Storybook. The --flavor flag selects which links to emit; everything
// else — including support.html and privacy.html, rendered from markdown
// through the same chrome — is identical.
//
// Usage: node scripts/build-docs.mjs --out <dir> [--flavor server|pages]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { marked } from "marked";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = path.join(repoRoot, "docs");
const assetsDir = path.join(repoRoot, "scripts", "docs-site");
const REPO_URL = "https://github.com/tomjose92/agora";
const PAGES_URL = "https://tomjose92.github.io/agora/";

const { guides } = await import(
  pathToFileURL(path.join(repoRoot, "web/public/docs/coding-agents/guide-data.js")).href
);

const outFlag = process.argv.indexOf("--out");
if (outFlag === -1 || !process.argv[outFlag + 1]) {
  console.error("usage: node scripts/build-docs.mjs --out <dir> [--flavor server|pages]");
  process.exit(1);
}
const outDir = path.resolve(process.cwd(), process.argv[outFlag + 1]);
const flavorFlag = process.argv.indexOf("--flavor");
const flavor = flavorFlag === -1 ? "server" : process.argv[flavorFlag + 1];
if (flavor !== "server" && flavor !== "pages") {
  console.error(`unknown --flavor: ${flavor} (expected server or pages)`);
  process.exit(1);
}
const isPages = flavor === "pages";

// Standalone site pages: rendered with the full chrome but kept out of the
// Guides nav group, the pager, and the landing cards. Their output names
// (support.html, privacy.html) are load-bearing — the mobile app and the
// App Store listing link them directly.
const SITE_PAGES = ["support.md", "privacy.md"];

// Guides in reading order; any new doc lands after these, alphabetically.
const ORDER = ["ARCHITECTURE.md", "PROTOCOL.md", "DEPLOYMENT.md", "AUTH.md"];
const sources = fs
  .readdirSync(docsDir)
  .filter((f) => f.endsWith(".md") && !SITE_PAGES.includes(f))
  .sort((a, b) => {
    const ia = ORDER.indexOf(a);
    const ib = ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
const docSet = new Set([...sources, ...SITE_PAGES]);

const htmlName = (mdName) => mdName.replace(/\.md$/, ".html");
const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);

// ---------------------------------------------------------------------------
// Markdown processing
// ---------------------------------------------------------------------------

// Rewrite relative markdown links before rendering: sibling guides point at
// their rendered .html; anything reaching outside docs/ points at GitHub
// (those files aren't part of the published site).
function rewriteLinks(md) {
  return md.replace(
    /\]\((?!(?:[a-z][a-z0-9+.-]*:)|\/\/|#)([^)\s]+?)(#[^)\s]*)?\)/g,
    (match, target, anchor = "") => {
      const clean = target.replace(/^\.\//, "");
      if (docSet.has(clean)) return `](${htmlName(clean)}${anchor})`;
      if (clean === "../README.md") return `](${REPO_URL}#readme)`;
      if (clean.startsWith("../")) return `](${REPO_URL}/blob/main/${clean.slice(3)}${anchor})`;
      return match;
    },
  );
}

// GitHub-compatible heading slugs so existing #anchors keep working.
function slugify(headingHtml) {
  return headingHtml
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z#0-9]+;/gi, "")
    .toLowerCase()
    .trim()
    .replace(/[^\w -]/g, "")
    .replace(/ /g, "-");
}

// TOC/search text is plain text, so undo marked's entity escaping (it gets
// re-escaped once at render time).
const unescapeHtml = (value) =>
  value.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e) => ({
    amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'",
  })[e]);

// Adds ids + hover anchors to headings and collects the h2/h3 outline.
function addHeadingAnchors(html) {
  const seen = new Map();
  const toc = [];
  const out = html.replace(/<h([1-4])>([\s\S]*?)<\/h\1>/g, (_m, level, inner) => {
    let slug = slugify(inner);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    const text = unescapeHtml(inner.replace(/<[^>]+>/g, ""));
    if (level === "2" || level === "3") toc.push({ level: Number(level), id: slug, text });
    return `<h${level} id="${slug}">${inner}<a class="anchor" href="#${slug}" aria-label="Link to this section">#</a></h${level}>`;
  });
  return { html: out, toc };
}

// Wrap fenced code in .code-block (lang label + copy-button mount point) and
// tables in a horizontal scroll container.
function wrapBlocks(html) {
  return html
    .replace(
      /<pre><code(?: class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g,
      (_m, lang = "", body) =>
        `<div class="code-block" data-lang="${escapeHtml(lang)}"><pre><code>${body}</code></pre></div>`,
    )
    .replace(/<table>([\s\S]*?)<\/table>/g, '<div class="table-wrap"><table>$1</table></div>');
}

function firstParagraph(md) {
  const lines = md.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].startsWith("# ")) i++;
  i++;
  while (i < lines.length && lines[i].trim() === "") i++;
  const para = [];
  while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("#")) {
    para.push(lines[i].trim());
    i++;
  }
  return para
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "");
}

marked.setOptions({ gfm: true });

function loadDoc(name) {
  const raw = fs.readFileSync(path.join(docsDir, name), "utf8");
  // Drop the "back to README" comment; the chrome provides navigation.
  const md = raw.replace(/^<!--[\s\S]*?-->\s*/, "");
  const title = (md.match(/^# (.+)$/m)?.[1] ?? htmlName(name)).trim();
  const rendered = addHeadingAnchors(marked.parse(rewriteLinks(md)));
  return {
    name,
    file: htmlName(name),
    title,
    intro: firstParagraph(md),
    body: wrapBlocks(rendered.html),
    toc: rendered.toc,
  };
}

const docs = sources.map(loadDoc);
const sitePages = SITE_PAGES.map(loadDoc);

// ---------------------------------------------------------------------------
// Site model
// ---------------------------------------------------------------------------

const agentEntries = Object.entries(guides).map(([key, guide]) => ({
  key,
  href: `coding-agents/${key}.html`,
  title: guide.name,
  description: guide.description,
  logo: `coding-agents/${guide.logo}`,
}));

const NAV_GROUPS = [
  {
    label: "Guides",
    items: [
      { title: "Overview", href: "index.html", key: "index" },
      ...docs.map((d) => ({ title: d.title, href: d.file, key: d.file })),
    ],
  },
  {
    label: "Coding agents",
    items: [
      { title: "Overview", href: "coding-agents/index.html" },
      ...agentEntries.map(({ title, href }) => ({ title, href })),
    ],
  },
  {
    label: "Project",
    items: [
      { title: "Support", href: "support.html", key: "support.html" },
      { title: "Privacy policy", href: "privacy.html", key: "privacy.html" },
      // Storybook is deployed with the Pages site, not bundled into web/dist.
      { title: "Storybook", href: isPages ? "storybook/" : `${PAGES_URL}storybook/` },
      { title: "GitHub", href: REPO_URL },
      { title: "README", href: `${REPO_URL}#readme` },
    ],
  },
];

function navHtml(currentKey) {
  return NAV_GROUPS.map(
    (group) =>
      `<div class="nav-group">${group.label}</div>\n` +
      group.items
        .map(
          (item) =>
            `<a class="nav-item${item.key === currentKey ? " active" : ""}" href="${item.href}">${escapeHtml(item.title)}</a>`,
        )
        .join("\n"),
  ).join("\n");
}

const topbar = `
<header class="topbar">
  <button class="menu-btn" id="menu-btn" aria-label="Toggle navigation">&#9776;</button>
  <a class="brand" href="index.html"><span class="logo">A</span><span>Agora</span><span class="brand-sub">Docs</span></a>
  <div class="topbar-spacer"></div>
  <div class="search">
    <input id="search-input" type="search" placeholder="Search docs" autocomplete="off" spellcheck="false" />
    <kbd class="search-kbd">/</kbd>
    <div id="search-results" hidden></div>
  </div>
  <a class="topbar-link" href="${REPO_URL}">GitHub</a>
</header>`;

function head(title, description) {
  return `<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — Agora docs</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <link rel="icon" href="icon.png" />
  <link rel="stylesheet" href="docs.css" />
</head>`;
}

// pager is {prev, next} for guides, or null for standalone site pages.
function contentPage(doc, pager) {
  const pagerHtml = pager
    ? `    <nav class="pager">
      <a href="${pager.prev.file}"><span class="label">&larr; Previous</span><span class="title">${escapeHtml(pager.prev.title)}</span></a>
      <a class="next" href="${pager.next.file}"><span class="label">Next &rarr;</span><span class="title">${escapeHtml(pager.next.title)}</span></a>
    </nav>
`
    : "";
  const tocHtml = doc.toc
    .map(
      (h) =>
        `<a class="${h.level === 3 ? "lvl3" : "lvl2"}" href="#${h.id}">${escapeHtml(h.text)}</a>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
${head(doc.title, doc.intro.slice(0, 155))}
<body>
<div class="scrim" id="scrim"></div>
${topbar}
<div class="layout">
  <aside class="sidebar" id="sidebar"><nav>
${navHtml(doc.file)}
  </nav></aside>
  <main class="main">
    <nav class="crumbs"><a href="index.html">Docs</a><span class="sep">/</span><span>${escapeHtml(doc.title)}</span></nav>
    <article class="prose">
${doc.body}
    </article>
${pagerHtml}    <footer class="page-footer">Also readable on <a href="${REPO_URL}/blob/main/docs/${doc.name}">GitHub</a>.</footer>
  </main>
  <aside class="toc-rail">
    <div class="toc-title">On this page</div>
    <nav class="toc">
${tocHtml}
    </nav>
  </aside>
</div>
<script src="docs.js" defer></script>
</body>
</html>
`;
}

function landingPage() {
  const guideCards = docs
    .map(
      (d) =>
        `<a class="card" href="${d.file}"><h3>${escapeHtml(d.title)}</h3><p>${escapeHtml(d.intro)}</p></a>`,
    )
    .join("\n");
  const agentCards = agentEntries
    .map(
      (a) =>
        `<a class="card agent" href="${a.href}"><img src="${a.logo}" alt="" /><span><h3>${escapeHtml(a.title)}</h3><p>${escapeHtml(a.description)}</p></span></a>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
${head("Documentation", "Documentation for Agora, the self-hosted chat app where people and AI agents share rooms.")}
<body class="landing">
<div class="scrim" id="scrim"></div>
${topbar}
<main class="landing-main">
  <header class="hero">
    <span class="kicker">Agora documentation</span>
    <h1>People and AI agents, sharing rooms</h1>
    <p>Agora is a self-hosted chat app: groups, channels, threads, and files,
    where the other members are AI agents. These guides cover the system
    design, the agent protocol, deployment, and accounts — plus step-by-step
    setup for the coding-agent CLIs.</p>
  </header>
  <section>
    <div class="section-head"><h2>Guides</h2></div>
    <div class="cards">
${guideCards}
    </div>
  </section>
  <section>
    <div class="section-head"><h2>Coding agents</h2><a href="coding-agents/index.html">Overview &rarr;</a></div>
    <div class="cards">
${agentCards}
    </div>
  </section>
  <footer class="landing-footer">
    <a href="support.html">Support</a> &middot;
    <a href="privacy.html">Privacy policy</a> &middot;
    <a href="${isPages ? "storybook/" : `${PAGES_URL}storybook/`}">Storybook</a> &middot;
    <a href="${REPO_URL}">GitHub</a> &middot;
    <a href="${REPO_URL}#readme">README</a>${
      isPages
        ? ""
        : ` &middot;
    <a href="../">Open Agora</a>`
    }
  </footer>
</main>
<script src="docs.js" defer></script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Search index
// ---------------------------------------------------------------------------

// {t: page title, p: page href, h: heading text ("" for the page itself),
//  id: anchor id ("" for the page itself)}
const AGENT_SECTIONS = [
  ["Setup", "setup"],
  ["Commands in Agora", "commands"],
  ["Environment variables", "configuration"],
  ["Security model", "security"],
  ["Troubleshooting", "troubleshooting"],
];
const searchIndex = [
  ...[...docs, ...sitePages].flatMap((d) => [
    { t: d.title, p: d.file, h: "", id: "" },
    ...d.toc.map((h) => ({ t: d.title, p: d.file, h: h.text, id: h.id })),
  ]),
  { t: "Coding agents", p: "coding-agents/index.html", h: "", id: "" },
  ...agentEntries.flatMap((a) => [
    { t: a.title, p: a.href, h: "", id: "" },
    ...AGENT_SECTIONS.map(([h, id]) => ({ t: a.title, p: a.href, h, id })),
  ]),
];

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

fs.mkdirSync(outDir, { recursive: true });
docs.forEach((doc, i) => {
  const prev = i === 0 ? { title: "Overview", file: "index.html" } : docs[i - 1];
  const next =
    i === docs.length - 1
      ? { title: "Coding agents", file: "coding-agents/index.html" }
      : docs[i + 1];
  fs.writeFileSync(path.join(outDir, doc.file), contentPage(doc, { prev, next }));
});
sitePages.forEach((doc) => fs.writeFileSync(path.join(outDir, doc.file), contentPage(doc, null)));
fs.writeFileSync(path.join(outDir, "index.html"), landingPage());
fs.writeFileSync(path.join(outDir, "search-index.json"), JSON.stringify(searchIndex));
for (const asset of ["docs.css", "docs.js"]) {
  fs.copyFileSync(path.join(assetsDir, asset), path.join(outDir, asset));
}
// Favicon + the agent guides' brand mark (they reference ../icon.png).
fs.copyFileSync(path.join(repoRoot, "web/public/icon.png"), path.join(outDir, "icon.png"));

console.log(`docs: rendered ${docs.length + sitePages.length + 1} pages into ${outDir}`);
