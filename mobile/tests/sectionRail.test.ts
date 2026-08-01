import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { Message } from "@agora/core";
import {
  MAX_VISIBLE_SECTION_DOTS,
  SectionRail,
} from "../src/components/SectionRail";

const message = (id: number, authorType: "user" | "agent"): Message => ({
  id,
  channel_id: "general",
  thread_id: null,
  author_type: authorType,
  author_id: authorType === "user" ? "alice" : "helper",
  author_name: authorType === "user" ? "Alice" : "Helper",
  text: `Message ${id}`,
  ts: 1,
  attachments: [],
});

function render(messages: Message[], activeMessageId: number | null, onJump = jest.fn()) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(SectionRail, { messages, activeMessageId, onJump }),
    );
  });
  return { tree, onJump };
}

const dots = (tree: TestRenderer.ReactTestRenderer) =>
  tree.root.findAll(
    (node) => typeof node.type === "string" && node.props?.accessibilityRole === "button",
    { deep: true },
  );

describe("SectionRail", () => {
  it("hides below two sections", () => {
    expect(render([message(1, "user"), message(2, "agent")], 1).tree.toJSON()).toBeNull();
  });

  it("selects and jumps to the active conversational section", () => {
    const onJump = jest.fn();
    const { tree } = render(
      [message(1, "user"), message(2, "agent"), message(3, "user")],
      3,
      onJump,
    );
    const renderedDots = dots(tree);
    expect(renderedDots.map((dot) => dot.props.accessibilityState.selected)).toEqual([false, true]);
    const pressables = tree.root.findAll(
      (node) => node.props?.accessibilityRole === "button" && typeof node.props?.onPress === "function",
      { deep: true },
    );
    act(() => pressables[0].props.onPress());
    expect(onJump).toHaveBeenCalledWith(1);
  });

  it("caps overflow and keeps the active dot visible", () => {
    const messages = Array.from({ length: 40 }, (_, index) =>
      message(index + 1, index % 2 === 0 ? "user" : "agent"),
    );
    for (const active of [1, 21, 39]) {
      const renderedDots = dots(render(messages, active).tree);
      expect(renderedDots).toHaveLength(MAX_VISIBLE_SECTION_DOTS);
      expect(renderedDots.filter((dot) => dot.props.accessibilityState.selected)).toHaveLength(1);
    }
  });

  it("uses absolute overlay geometry without consuming message width", () => {
    const { tree } = render([message(1, "user"), message(2, "user")], 1);
    const rail = tree.root.findAll(
      (node) => typeof node.type !== "string" && node.props?.pointerEvents === "box-none",
      { deep: true },
    )[0];
    const style = Object.assign({}, ...([] as object[]).concat(rail.props.style));
    expect(style).toMatchObject({ position: "absolute", right: 2, width: 20 });
    expect(style).not.toHaveProperty("left");
  });
});
