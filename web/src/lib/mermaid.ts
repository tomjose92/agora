/* Lazy mermaid rendering — a close port of agoLoadMermaid/agoRenderMermaid
   from the retired vanilla agora.js, sharing the vendored /mermaid.min.js (root-absolute: a
   relative path would 404 under /app2/). Document-wide and self-recursing:
   render results are cached by graph source ("" = known-bad) and re-applied
   whenever a caller kicks the runner, so late mounts and re-renders always
   converge. */

declare global {
  interface Window {
    mermaid?: {
      initialize(cfg: Record<string, unknown>): void;
      render(id: string, src: string): Promise<{ svg: string }>;
    };
  }
}

const svgCache = new Map<string, string>(); // graph source -> svg ("" = failed)
let loadPromise: Promise<void> | null = null;
let seq = 0;

function loadMermaid(): Promise<void> {
  if (window.mermaid) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = new Promise<void>((resolve) => {
      const s = document.createElement("script");
      s.src = "/mermaid.min.js";
      s.onload = () => resolve();
      s.onerror = () => { loadPromise = null; resolve(); };
      document.head.appendChild(s);
    }).then(() => {
      window.mermaid?.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
    });
  }
  return loadPromise;
}

export async function renderMermaid(): Promise<void> {
  const nodes = document.querySelectorAll<HTMLElement>(".md-mermaid:not(.rendered)");
  if (!nodes.length) return;
  // Apply what's cached; collect what still needs a render.
  const need = new Set<string>();
  nodes.forEach(node => {
    const src = (node.textContent || "").trim();
    const svg = svgCache.get(src);
    if (svg) {
      node.innerHTML = svg;
      node.classList.add("rendered");
    } else if (svg === undefined) {
      need.add(src);
    }
  });
  if (!need.size) return;
  await loadMermaid();
  if (!window.mermaid) return; // offline/blocked: leave the code standing
  for (const src of need) {
    if (svgCache.has(src)) continue;
    const id = `ago-mmd-${++seq}`;
    try {
      const { svg } = await window.mermaid.render(id, src);
      svgCache.set(src, svg);
    } catch {
      svgCache.set(src, "");
      // Mermaid can leave its scratch element behind on a parse error.
      const scratch = document.getElementById(id) || document.getElementById(`d${id}`);
      if (scratch) scratch.remove();
    }
  }
  // Apply what just rendered (nodes may have re-mounted meanwhile).
  void renderMermaid();
}
