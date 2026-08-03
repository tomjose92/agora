import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { LinkPreferences } from "../src/components/LinkPreferences";

it("reports browser selections and disables unavailable Chrome", () => {
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
  const unavailable = tree!.root.findAll((node) =>
    node.props.accessibilityRole === "radio" && typeof node.props.onPress === "function"
  );
  expect(unavailable).toHaveLength(3);
  expect(unavailable[2].props.accessibilityState).toMatchObject({ disabled: true });
});

it("keeps a stored Chrome choice selected when Chrome is unavailable", () => {
  let tree: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(React.createElement(LinkPreferences, {
      preferNativeApps: true,
      browser: "chrome",
      onPreferNativeAppsChange: () => {},
      onBrowserChange: () => {},
      chromeAvailable: false,
    }));
  });
  const chrome = tree!.root.findAll((node) =>
    node.props.accessibilityRole === "radio" &&
    typeof node.props.onPress === "function"
  )[2];
  expect(chrome.props.accessibilityState).toMatchObject({
    checked: true,
    disabled: true,
  });
  expect(JSON.stringify(tree!.toJSON())).toContain("Not installed");
});
