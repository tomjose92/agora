import type { Meta, StoryObj } from "@storybook/react-native";
import { EChartBlock } from "./EChart";

const line = JSON.stringify({
  title: { text: "Weekly activity" },
  tooltip: { trigger: "axis" },
  xAxis: { type: "category", data: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] },
  yAxis: { type: "value" },
  series: [{ type: "line", smooth: true, data: [12, 19, 15, 28, 24, 32, 30] }],
});

const meta = {
  title: "Native/Messages/ECharts",
  component: EChartBlock,
  args: { code: line, maxWidth: 340 },
} satisfies Meta<typeof EChartBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ResponsiveLine: Story = {};
export const WideScrollable: Story = {
  args: { code: JSON.stringify({
    agora: { width: 1200, height: 300 },
    option: {
      title: { text: "Long timeline" }, tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: Array.from({ length: 24 }, (_, i) => `${i}:00`) },
      yAxis: { type: "value" }, series: [{ type: "bar", data: Array.from({ length: 24 }, (_, i) => (i * 7) % 31) }],
    },
  }) },
};
export const InvalidJson: Story = { args: { code: "{ definitely not json" } };
