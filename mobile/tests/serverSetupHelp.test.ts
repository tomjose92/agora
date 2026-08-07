import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  SERVER_SETUP_GUIDE_URL,
  ServerSetupHelp,
  shouldShowServerSetupHelp,
} from "../src/components/ServerSetupHelp";

describe("ServerSetupHelp", () => {
  test("explains the server requirement and opens the hosted setup guide", () => {
    const onOpenGuide = jest.fn();
    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        React.createElement(ServerSetupHelp, { onOpenGuide }),
      );
    });

    const rendered = JSON.stringify(tree.toJSON());
    expect(rendered).toContain("Don't have a server yet?");
    expect(rendered).toContain("connects to a server run by you or your organization");

    const action = tree.root.findByProps({
      accessibilityLabel: "Learn how to set up an Agora server",
    });
    expect(action.props.accessibilityRole).toBe("button");
    act(() => action.props.onPress());
    expect(onOpenGuide).toHaveBeenCalledWith(SERVER_SETUP_GUIDE_URL);
    expect(SERVER_SETUP_GUIDE_URL).toBe(
      "https://tomjose92.github.io/agora/self-hosting/",
    );
  });

  test("waits for recent servers to load and stays hidden when one exists", () => {
    expect(shouldShowServerSetupHelp(false, [])).toBe(false);
    expect(shouldShowServerSetupHelp(true, ["https://agora.example.com"])).toBe(false);
    expect(shouldShowServerSetupHelp(true, [])).toBe(true);
  });
});
