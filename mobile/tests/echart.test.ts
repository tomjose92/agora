import { echartHtml } from "../src/lib/echarts";
import { normalizeEChart } from "@agora/core";

test("chart WebView pins ECharts and keeps option markup out of HTML", () => {
  const chart = normalizeEChart(JSON.stringify({
    tooltip: { formatter: "<img src=x onerror=alert(1)>" },
    series: [{ type: "bar", data: [1, 2] }],
  }));
  const html = echartHtml(chart);
  expect(html).toContain("echarts@6.1.0/dist/echarts.min.js");
  expect(html).toContain("\\u003cimg src=x onerror=alert(1)>");
  expect(html).not.toContain('formatter":"<img');
  expect(html).toContain('renderMode":"richText"');
  expect(html).toContain('confine":true');
});
