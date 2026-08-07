import { describe, expect, it } from "vitest";
import { normalizeEChart } from "../src/lib/echarts";

describe("normalizeEChart", () => {
  it("accepts a bare option and secures nested tooltips", () => {
    const chart = normalizeEChart(JSON.stringify({
      title: { text: "Sales" },
      tooltip: { formatter: "<img src=x onerror=alert(1)>", extraCssText: "color:red" },
      series: [{ type: "bar", tooltip: { trigger: "item" }, data: [1, 2] }],
    }));
    expect(chart.title).toBe("Sales");
    expect(chart.option.tooltip).toEqual({
      formatter: "<img src=x onerror=alert(1)>", renderMode: "richText", confine: true,
    });
    expect((chart.option.series as Record<string, unknown>[])[0].tooltip).toEqual({
      trigger: "item", renderMode: "richText", confine: true,
    });
  });

  it("accepts the Agora sizing envelope and clamps dimensions", () => {
    const chart = normalizeEChart(JSON.stringify({
      agora: { width: 99_999, height: 100 }, option: { series: [] },
    }));
    expect(chart.width).toBe(4_000);
    expect(chart.height).toBe(220);
  });

  it("removes external image loading paths", () => {
    const chart = normalizeEChart(JSON.stringify({
      series: [{ symbol: "image://https://tracker.test/pixel", data: [1] }],
      graphic: { elements: [{ type: "image", style: { image: "https://tracker.test/x" } }, { type: "text" }] },
      backgroundColor: { image: "https://tracker.test/background" },
    }));
    expect((chart.option.series as Record<string, unknown>[])[0].symbol).toBe("circle");
    expect(((chart.option.graphic as Record<string, unknown>).elements as unknown[])).toEqual([{ type: "text" }]);
    expect(chart.option.backgroundColor).toEqual({});
  });

  it("rejects invalid or excessive input", () => {
    expect(() => normalizeEChart("not json")).toThrow("valid JSON");
    expect(() => normalizeEChart("[]")).toThrow("must be an object");
    expect(() => normalizeEChart(JSON.stringify({ series: [{ data: Array(10_001).fill(1) }] })))
      .toThrow("too many data points");
  });
});
