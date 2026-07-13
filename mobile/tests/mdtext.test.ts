/* MdText table/code rendering. The regression these guard: a horizontal
   ScrollView only scrolls natively when its frame has a *definite* width, so
   MdText must feed the measured onLayout width into the table (and code) wrap
   as a numeric maxWidth. Without it the ScrollView grows to content width and
   the bubble just clips it — no horizontal scroll. */

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ScrollView, StyleSheet } from "react-native";
import { MdText } from "../src/components/MdText";

const TABLE = "| Category | Transactions | USD |\n|---|---|---|\n| PAI ATM | 3 | $159.00 |";

function fireLayout(node: TestRenderer.ReactTestInstance, width: number) {
  act(() => {
    node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 40 } } });
  });
}

function maxWidthOf(style: unknown): number | undefined {
  return (StyleSheet.flatten(style) as { maxWidth?: number }).maxWidth;
}

test("table ScrollView has no definite width before layout, and the measured width after", () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(MdText, { text: TABLE }));
  });
  const scroll = () => tree.root.findAllByType(ScrollView)[0];

  // Before measurement the frame is unconstrained (would grow to content).
  expect(maxWidthOf(scroll().props.style)).toBeUndefined();

  // The root View carries the onLayout; feeding it the bubble's inner width…
  const layoutHost = tree.root.findAll((n) => typeof n.props.onLayout === "function")[0];
  fireLayout(layoutHost, 260);

  // …caps the table's ScrollView to that definite pixel width, so a wider
  // table overflows the frame and scrolls.
  expect(maxWidthOf(scroll().props.style)).toBe(260);
});

test("code block ScrollView is capped to the measured width too", () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(MdText, { text: "```\na very long line of code goes here\n```" }),
    );
  });
  const layoutHost = tree.root.findAll((n) => typeof n.props.onLayout === "function")[0];
  fireLayout(layoutHost, 300);
  expect(maxWidthOf(tree.root.findAllByType(ScrollView)[0].props.style)).toBe(300);
});
