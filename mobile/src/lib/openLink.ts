/* Open a tapped link. http(s) goes to the in-app browser sheet
   (SFSafariViewController / Chrome Custom Tab) — the standard mobile pattern,
   and more reliable than Linking.openURL, which silently no-ops on Android
   when no default-browser intent matches. Other schemes (mailto:, tel:, …)
   fall through to the OS handler. Failures are swallowed: a dead link should
   never crash the chat. */

import * as WebBrowser from "expo-web-browser";
import { Linking } from "react-native";

export async function openLink(url: string): Promise<void> {
  try {
    if (/^https?:\/\//i.test(url)) {
      await WebBrowser.openBrowserAsync(url);
    } else {
      await Linking.openURL(url);
    }
  } catch {
    await Linking.openURL(url).catch(() => {});
  }
}
