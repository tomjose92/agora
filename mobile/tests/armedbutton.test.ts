import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ArmedButton } from "../src/components/ArmedButton";

describe("ArmedButton", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function render(onConfirm = jest.fn()) {
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        React.createElement(ArmedButton, {
          label: "Remove",
          armedLabel: "Tap again",
          onConfirm,
        }),
      );
    });
    return { tree, onConfirm };
  }

  const button = (tree: TestRenderer.ReactTestRenderer) =>
    tree.root.find((node) => typeof node.props.onPress === "function");
  const rendered = (tree: TestRenderer.ReactTestRenderer) =>
    JSON.stringify(tree.toJSON());

  test("arms first and confirms exactly once on the second press", () => {
    const { tree, onConfirm } = render();

    act(() => button(tree).props.onPress());
    expect(rendered(tree)).toContain("Tap again");
    expect(button(tree).props.accessibilityLabel).toBe("Confirm: Remove");
    expect(button(tree).props.accessibilityHint).toContain("five seconds");
    expect(onConfirm).not.toHaveBeenCalled();

    act(() => button(tree).props.onPress());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(rendered(tree)).toContain("Remove");
  });

  test("disarms after five seconds without confirming", () => {
    const { tree, onConfirm } = render();
    act(() => button(tree).props.onPress());
    act(() => jest.advanceTimersByTime(5_000));

    expect(rendered(tree)).toContain("Remove");
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
