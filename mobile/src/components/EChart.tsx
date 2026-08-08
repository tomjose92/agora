import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { BarChart3, Maximize2, X } from "lucide-react-native";
import { normalizeEChart, type NormalizedEChart } from "@agora/core";
import { WebView } from "react-native-webview";
import { colors, mono } from "../lib/theme";
import { echartHtml } from "../lib/echarts";
import { Icon } from "./Icon";

/* `height` is the native box the chart paints into; the WebView stage fills it.
   Inline cards stay bounded so a channel of charts scrolls normally, while the
   expanded modal passes its measured body height. */
function ChartWebView({ chart, height }: { chart: NormalizedEChart; height: number }) {
  return (
    <WebView
      originWhitelist={["*"]}
      source={{ html: echartHtml(chart) }}
      javaScriptEnabled
      scrollEnabled
      nestedScrollEnabled
      showsHorizontalScrollIndicator
      style={[styles.web, { height }]}
      containerStyle={styles.webContainer}
    />
  );
}

const INLINE_MAX_HEIGHT = 320;

export function EChartBlock({ code, maxWidth }: { code: string; maxWidth?: number }) {
  const result = React.useMemo(() => {
    try { return { chart: normalizeEChart(code), error: "" }; }
    catch (error) { return { chart: null, error: (error as Error).message }; }
  }, [code]);
  const [open, setOpen] = React.useState(false);
  const [bodyHeight, setBodyHeight] = React.useState(0);
  const onBody = React.useCallback((event: LayoutChangeEvent) => {
    setBodyHeight(Math.round(event.nativeEvent.layout.height));
  }, []);

  if (!result.chart) {
    return (
      <View style={[styles.error, maxWidth ? { maxWidth } : null]}>
        <Text style={styles.errorTitle}>Could not render ECharts chart</Text>
        <Text style={styles.errorText}>{result.error}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <Text style={styles.source}>{code}</Text>
        </ScrollView>
      </View>
    );
  }
  const chart = result.chart;
  return (
    <>
      <View style={[styles.card, maxWidth ? { width: maxWidth, maxWidth } : null]}>
        <View style={styles.head}>
          <Icon icon={BarChart3} size={14} color={colors.a2} />
          <Text style={styles.title} numberOfLines={1}>{chart.title}</Text>
          <Pressable style={styles.expand} onPress={() => setOpen(true)} accessibilityLabel={`Expand chart: ${chart.title}`}>
            <Icon icon={Maximize2} size={13} color={colors.a2} />
            <Text style={styles.expandText}>expand</Text>
          </Pressable>
        </View>
        <ChartWebView chart={chart} height={Math.min(chart.height, INLINE_MAX_HEIGHT)} />
      </View>
      {open ? (
        <Modal animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setOpen(false)}>
          <View style={styles.modal}>
            <View style={styles.modalHead}>
              <Icon icon={BarChart3} size={16} color={colors.a2} />
              <Text style={styles.modalTitle} numberOfLines={1}>{chart.title}</Text>
              <Pressable onPress={() => setOpen(false)} hitSlop={10} accessibilityLabel="Close chart">
                <Icon icon={X} size={21} color={colors.dim} />
              </Pressable>
            </View>
            <View style={styles.modalBody} onLayout={onBody}>
              {bodyHeight > 0 ? <ChartWebView chart={chart} height={bodyHeight} /> : null}
            </View>
          </View>
        </Modal>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: "stretch", overflow: "hidden", borderWidth: 1, borderColor: colors.border, borderRadius: 9, backgroundColor: "#0b0d12" },
  head: { minHeight: 38, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  title: { flex: 1, color: colors.text, fontSize: 12, fontWeight: "700" },
  expand: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 7, paddingLeft: 8 },
  expandText: { color: colors.a2, fontSize: 11.5, fontWeight: "600" },
  web: { backgroundColor: "#0b0d12" },
  webContainer: { backgroundColor: "#0b0d12" },
  modal: { flex: 1, backgroundColor: "#0b0d12", paddingTop: 54 },
  modalBody: { flex: 1 },
  modalHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  modalTitle: { flex: 1, color: colors.text, fontSize: 14, fontWeight: "700" },
  error: { alignSelf: "flex-start", gap: 5, padding: 10, borderWidth: 1, borderColor: "rgba(248,113,113,.35)", borderRadius: 8, backgroundColor: "rgba(127,29,29,.14)" },
  errorTitle: { color: "#fca5a5", fontWeight: "700", fontSize: 12 },
  errorText: { color: colors.dim, fontSize: 11.5 },
  source: { ...mono, paddingTop: 3, color: colors.faint, fontSize: 11 },
});
