/* Open a tapped link using the user's two independent preferences: supported
   native apps get first refusal, then the selected browser handles http(s).
   Other schemes (mailto:, tel:, …) go directly to the OS. The default helper
   swallows failures so a dead link cannot crash chat; callers with visible
   error handling use openLinkOrThrow. */

import * as WebBrowser from "expo-web-browser";
import { Linking, Platform } from "react-native";
import { usePrefs, type LinkBrowser } from "../state/prefs";

export function nativeAppUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (
      host === "maps.google.com" ||
      ((host === "google.com" || host === "www.google.com") &&
        url.pathname.startsWith("/maps"))
    ) {
      if (url.pathname.startsWith("/maps/search")) {
        const query = url.searchParams.get("query");
        return query ? `comgooglemaps://?q=${encodeURIComponent(query)}` : null;
      }
      if (url.pathname.startsWith("/maps/dir")) {
        const destination = url.searchParams.get("destination");
        return destination
          ? `comgooglemaps://?daddr=${encodeURIComponent(destination)}&directionsmode=driving`
          : null;
      }
      return null;
    }
    if (host === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id ? `vnd.youtube://${id}` : null;
    }
    if (
      host === "youtube.com" ||
      host === "www.youtube.com" ||
      host === "m.youtube.com"
    ) {
      const id = url.pathname === "/watch" ? url.searchParams.get("v") : null;
      return id ? `vnd.youtube://${id}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function chromeUrl(raw: string): string {
  return raw
    .replace(/^https:/i, "googlechromes:")
    .replace(/^http:/i, "googlechrome:");
}

export async function isChromeAvailable(): Promise<boolean> {
  if (Platform.OS === "ios") return Linking.canOpenURL("googlechrome://");
  if (Platform.OS === "android") {
    const browsers = await WebBrowser.getCustomTabsSupportingBrowsersAsync();
    return browsers.servicePackages.includes("com.android.chrome");
  }
  return false;
}

async function openInBrowser(url: string, browser: LinkBrowser): Promise<void> {
  if (browser === "in-app") {
    await WebBrowser.openBrowserAsync(url);
  } else if (browser === "chrome" && Platform.OS === "ios") {
    await Linking.openURL(chromeUrl(url));
  } else if (browser === "chrome" && Platform.OS === "android") {
    await WebBrowser.openBrowserAsync(url, {
      browserPackage: "com.android.chrome",
    });
  } else {
    await Linking.openURL(url);
  }
}

export async function openLinkOrThrow(url: string): Promise<void> {
  const { preferNativeApps, linkBrowser } = usePrefs.getState();
  if (!/^https?:\/\//i.test(url)) {
    await Linking.openURL(url);
    return;
  }
  const nativeUrl = preferNativeApps ? nativeAppUrl(url) : null;
  if (nativeUrl && (await Linking.canOpenURL(nativeUrl))) {
    try {
      await Linking.openURL(nativeUrl);
      return;
    } catch {
      // The app may have disappeared between probing and opening.
    }
  }
  try {
    await openInBrowser(url, linkBrowser);
  } catch (error) {
    // A selected browser may have been removed since Settings last checked.
    if (linkBrowser === "system") throw error;
    await Linking.openURL(url);
  }
}

export async function openLink(url: string): Promise<void> {
  await openLinkOrThrow(url).catch(() => {});
}
