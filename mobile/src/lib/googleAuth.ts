/* Google sign-in for the mobile app: the phone flavor of the same server-side
   OIDC flow the web UI and desktop shell use. We open the server's
   /api/auth/google/start in a system auth session with ?next= pointing at
   this app's deep link (agora://auth, or exp://… in dev); after consent the
   server redirects there with a freshly minted session token, which then
   takes the owner token's place in the keychain. */

import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";

export interface RedirectResult {
  token?: string;
  error?: string;
}

/** Pull token/error out of the server's redirect back to our deep link.
    Hand-parsed: Hermes' URL support is too patchy to trust here. */
export function parseRedirect(url: string): RedirectResult {
  const query = url.split(/[?]/).slice(1).join("?");
  const out: RedirectResult = {};
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq);
    const value = decodeURIComponent(pair.slice(eq + 1));
    if (key === "token" && value) out.token = value;
    if (key === "error" && value) out.error = value;
  }
  return out;
}

export function signInErrorMessage(reason: string | undefined): string {
  switch (reason) {
    case "no_access":
      return "That Google account isn't allowed on this instance";
    case "google_access_denied":
      return "Google sign-in was cancelled";
    default:
      return `Google sign-in failed${reason ? ` (${reason})` : ""}`;
  }
}

/** True when the server offers Google sign-in (unauthenticated probe). */
export async function googleEnabled(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/auth/config`);
    if (!res.ok) return false;
    const cfg = (await res.json()) as { google?: { enabled?: boolean } };
    return cfg.google?.enabled === true;
  } catch {
    return false;
  }
}

/** Run the browser round-trip and return the session token. Returns null
    when the user dismissed the sheet; throws on real failures.
    `selectAccount` forces Google's account chooser (retry after a rejected
    account, which silent re-auth would otherwise re-pick forever). */
export async function runGoogleFlow(
  baseUrl: string,
  selectAccount = false,
): Promise<string | null> {
  if (!(await googleEnabled(baseUrl))) {
    throw new Error("That server does not have Google sign-in configured");
  }
  const redirect = Linking.createURL("auth");
  const result = await WebBrowser.openAuthSessionAsync(
    `${baseUrl}/api/auth/google/start?next=${encodeURIComponent(redirect)}` +
      (selectAccount ? "&select_account=1" : ""),
    redirect,
  );
  if (result.type !== "success") return null;
  const { token, error } = parseRedirect(result.url);
  if (!token) throw new Error(signInErrorMessage(error));
  return token;
}
