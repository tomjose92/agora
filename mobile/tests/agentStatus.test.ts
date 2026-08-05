import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { Text, View } from "react-native";
import { AgentStatus } from "../src/components/AgentStatus";
import { colors } from "../src/lib/theme";

function render(live: boolean) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(React.createElement(AgentStatus, { live })); });
  return tree;
}

it.each([[true, "online", colors.green], [false, "offline", colors.faint]] as const)(
  "renders %s presence with text and token color", (live, label, color) => {
    const tree = render(live);
    const root = tree.root.findAllByType(View)[0];
    expect(root.props.accessibilityLabel).toBe(label);
    const text = tree.root.findByType(Text);
    expect(text.props.children).toBe(label);
    expect(text.props.style).toEqual(expect.arrayContaining([expect.objectContaining({ color })]));
    act(() => tree.unmount());
  },
);
