import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { LinkPreferences } from "../src/components/LinkPreferences";

it("shows Chrome only when installed and reports browser selections", () => {
  const change = jest.fn();
  let tree: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(LinkPreferences, {
      preferNativeApps: true,
      browser: "in-app",
      onPreferNativeAppsChange: () => {},
      onBrowserChange: change,
      chromeAvailable: true,
    }));
  });
  const radios = tree!.root.findAll((node) =>
    node.props.accessibilityRole === "radio" && typeof node.props.onPress === "function"
  );
  expect(radios).toHaveLength(3);
  act(() => radios[2].props.onPress());
  expect(change).toHaveBeenCalledWith("chrome");

  act(() => {
    tree!.update(React.createElement(LinkPreferences, {
      preferNativeApps: true,
      browser: "in-app",
      onPreferNativeAppsChange: () => {},
      onBrowserChange: change,
      chromeAvailable: false,
    }));
  });
  expect(tree!.root.findAll((node) =>
    node.props.accessibilityRole === "radio" && typeof node.props.onPress === "function"
  )).toHaveLength(2);
});
