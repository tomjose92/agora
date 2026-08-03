jest.mock("expo-web-browser", () => ({
  openBrowserAsync: jest.fn(),
  getCustomTabsSupportingBrowsersAsync: jest.fn(),
}));

import * as WebBrowser from "expo-web-browser";
import { Linking, Platform } from "react-native";
import { chromeUrl, nativeAppUrl, openLinkOrThrow } from "../src/lib/openLink";
import { usePrefs } from "../src/state/prefs";

const openBrowser = WebBrowser.openBrowserAsync as jest.Mock;
const originalPlatform = Platform.OS;

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  openBrowser.mockReset().mockResolvedValue({ type: "opened" });
  usePrefs.setState({ preferNativeApps: true, linkBrowser: "in-app" });
});

afterEach(() => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: originalPlatform });
});

describe("native app mapping", () => {
  it("maps supported URLs and rejects unrelated or invalid links", () => {
    expect(nativeAppUrl("https://github.com/openai/codex?tab=readme")).toBeNull();
    expect(nativeAppUrl("https://www.google.com/maps/search/?api=1&query=Goa")).toBe(
      "comgooglemaps://?q=Goa",
    );
    expect(nativeAppUrl("https://www.google.com/maps/dir/?api=1&destination=15.5%2C73.8")).toBe(
      "comgooglemaps://?daddr=15.5%2C73.8&directionsmode=driving",
    );
    expect(nativeAppUrl("https://www.google.com/maps/@15.5,73.8,12z")).toBeNull();
    expect(nativeAppUrl("https://youtu.be/abc123?t=4")).toBe("vnd.youtube://abc123");
    expect(nativeAppUrl("https://youtube.com/watch?v=xyz")).toBe("vnd.youtube://xyz");
    expect(nativeAppUrl("https://example.com/maps")).toBeNull();
    expect(nativeAppUrl("not a url")).toBeNull();
  });

  it("rewrites both HTTP schemes for Chrome on iOS", () => {
    expect(chromeUrl("https://example.com/a")).toBe("googlechromes://example.com/a");
    expect(chromeUrl("http://example.com/a")).toBe("googlechrome://example.com/a");
  });
});

describe("openLinkOrThrow", () => {
  it("opens a supported installed native app before the browser", async () => {
    jest.spyOn(Linking, "canOpenURL").mockResolvedValue(true);
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await openLinkOrThrow("https://www.google.com/maps/search/?api=1&query=Goa");
    expect(open).toHaveBeenCalledWith("comgooglemaps://?q=Goa");
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("uses the configured in-app browser when no native app is present", async () => {
    jest.spyOn(Linking, "canOpenURL").mockResolvedValue(false);
    await openLinkOrThrow("https://www.google.com/maps/search/?api=1&query=Goa");
    expect(openBrowser).toHaveBeenCalledWith(
      "https://www.google.com/maps/search/?api=1&query=Goa",
    );
  });

  it("can disable native-app routing and use the system browser", async () => {
    usePrefs.setState({ preferNativeApps: false, linkBrowser: "system" });
    const canOpen = jest.spyOn(Linking, "canOpenURL");
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await openLinkOrThrow("https://github.com/openai/codex");
    expect(canOpen).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("https://github.com/openai/codex");
  });

  it("targets Chrome custom tabs on Android", async () => {
    Object.defineProperty(Platform, "OS", { configurable: true, value: "android" });
    usePrefs.setState({ preferNativeApps: false, linkBrowser: "chrome" });
    await openLinkOrThrow("https://example.com");
    expect(openBrowser).toHaveBeenCalledWith("https://example.com", {
      browserPackage: "com.android.chrome",
    });
  });

  it("falls back to the system browser if the selected browser fails", async () => {
    usePrefs.setState({ preferNativeApps: false, linkBrowser: "in-app" });
    openBrowser.mockRejectedValue(new Error("removed"));
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await openLinkOrThrow("https://example.com");
    expect(open).toHaveBeenCalledWith("https://example.com");
  });
});
