import React from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { parseMd, type Span } from "../lib/mdlite";
import { colors, mono } from "../lib/theme";

function SpanText({ span }: { span: Span }) {
  switch (span.kind) {
    case "bold":
      return <Text style={styles.bold}>{span.text}</Text>;
    case "italic":
      return <Text style={styles.italic}>{span.text}</Text>;
    case "code":
      return <Text style={styles.code}>{span.text}</Text>;
    case "link":
      return (
        <Text style={styles.link} onPress={() => Linking.openURL(span.url)}>
          {span.text}
        </Text>
      );
    case "mention":
      return <Text style={styles.mention}>{span.text}</Text>;
    default:
      return <Text>{span.text}</Text>;
  }
}

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) => (
        <SpanText key={i} span={s} />
      ))}
    </>
  );
}

export function MdText({ text }: { text: string }) {
  const blocks = React.useMemo(() => parseMd(text), [text]);
  return (
    <View style={styles.root}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "codeblock":
            return (
              <ScrollView key={i} horizontal style={styles.pre}>
                <Text style={styles.preText}>{b.text}</Text>
              </ScrollView>
            );
          case "heading":
            return (
              <Text key={i} style={[styles.para, styles.bold]}>
                <Spans spans={b.spans} />
              </Text>
            );
          case "table":
            return (
              <ScrollView key={i} horizontal style={styles.tableWrap}>
                <View>
                  <View style={[styles.tr, styles.thead]}>
                    {b.head.map((cell, c) => (
                      <Text key={c} style={[styles.cell, styles.bold, alignStyle(b.aligns[c])]}>
                        <Spans spans={cell} />
                      </Text>
                    ))}
                  </View>
                  {b.rows.map((row, r) => (
                    <View key={r} style={styles.tr}>
                      {row.map((cell, c) => (
                        <Text key={c} style={[styles.cell, alignStyle(b.aligns[c])]}>
                          <Spans spans={cell} />
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            );
          default:
            return (
              <Text key={i} style={styles.para} selectable>
                <Spans spans={b.spans} />
              </Text>
            );
        }
      })}
    </View>
  );
}

function alignStyle(a: "" | "left" | "center" | "right") {
  return a ? { textAlign: a as "left" | "center" | "right" } : null;
}

const styles = StyleSheet.create({
  root: { gap: 6 },
  para: { color: colors.text, fontSize: 15, lineHeight: 21 },
  bold: { fontWeight: "700", color: colors.text },
  italic: { fontStyle: "italic" },
  code: {
    ...mono,
    fontSize: 13,
    color: colors.a2,
    backgroundColor: colors.panelStrong,
  },
  link: { color: colors.a2, fontWeight: "500" },
  mention: {
    color: "#b3a8ff",
    fontWeight: "600",
    backgroundColor: "rgba(139,124,255,0.18)",
  },
  pre: {
    backgroundColor: colors.panelStrong,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  preText: { ...mono, fontSize: 13, color: colors.text, padding: 10 },
  tableWrap: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    borderRadius: 8,
  },
  thead: { backgroundColor: colors.panelStrong },
  tr: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  cell: { color: colors.text, fontSize: 13.5, paddingVertical: 6, paddingHorizontal: 10, minWidth: 80 },
});
