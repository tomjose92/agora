export interface AgoraChartMeta {
  width?: number;
  height?: number;
}

export interface NormalizedEChart {
  option: Record<string, unknown>;
  width?: number;
  height: number;
  title: string;
}

const MAX_SOURCE_LENGTH = 250_000;
const MAX_DEPTH = 24;
const MAX_NODES = 30_000;
const MAX_ARRAY_LENGTH = 10_000;
const MAX_STRING_LENGTH = 50_000;

function finiteDimension(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(max, Math.max(min, value)))
    : undefined;
}

function chartTitle(option: Record<string, unknown>): string {
  const title = option.title;
  const first = Array.isArray(title) ? title[0] : title;
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const text = (first as Record<string, unknown>).text;
    if (typeof text === "string" && text.trim()) return text.trim().slice(0, 160);
  }
  return "ECharts chart";
}

/**
 * Parses and sanitizes an agent-authored ECharts option. Message charts are
 * data, never code: callbacks cannot survive JSON parsing, DOM-backed tooltip
 * HTML is disabled, and image resources are removed to prevent tracking loads.
 */
export function normalizeEChart(source: string): NormalizedEChart {
  if (source.length > MAX_SOURCE_LENGTH) throw new Error("Chart JSON is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Chart must contain valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Chart JSON must be an object");
  }

  const root = parsed as Record<string, unknown>;
  const enveloped = Object.hasOwn(root, "option");
  const rawOption = enveloped ? root.option : root;
  if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) {
    throw new Error("Chart option must be an object");
  }
  const meta = enveloped && root.agora && typeof root.agora === "object" && !Array.isArray(root.agora)
    ? root.agora as Record<string, unknown>
    : {};
  let nodes = 0;

  const clean = (value: unknown, key: string, depth: number): unknown => {
    nodes++;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("Chart JSON is too complex");
    if (value == null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
      if (value.length > MAX_STRING_LENGTH) throw new Error("Chart text is too long");
      // ECharts resolves image:// values through Image(), which would disclose
      // the viewer's address to an arbitrary message-authored URL.
      return /^image:\/\//i.test(value.trim()) ? "circle" : value;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LENGTH) throw new Error("Chart has too many data points");
      return value
        .map(item => clean(item, key, depth + 1))
        .filter(item => item !== undefined);
    }
    if (typeof value !== "object") return undefined;

    const input = value as Record<string, unknown>;
    // A graphic image element is another external resource-loading path.
    // `graphic` accepts these both directly and inside an `elements` array.
    if (input.type === "image") return undefined;
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(input)) {
      if (childKey === "extraCssText" || childKey === "image") continue;
      const next = clean(childValue, childKey, depth + 1);
      if (next !== undefined) output[childKey] = next;
    }
    if (key === "tooltip") {
      output.renderMode = "richText";
      output.confine = true;
      // String formatters can contain HTML. Rich-text mode prevents DOM
      // injection, while preserving ECharts' normal {a}/{b}/{c} templates.
      delete output.extraCssText;
    }
    return output;
  };

  const option = clean(rawOption, "option", 0) as Record<string, unknown>;
  return {
    option,
    width: finiteDimension(meta.width, 320, 4_000),
    height: finiteDimension(meta.height, 220, 900) ?? 360,
    title: chartTitle(option),
  };
}
