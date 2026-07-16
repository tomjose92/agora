/* Sign in with Apple: unlike Google (a server-brokered browser round-trip),
   this is the native path — Apple's system sheet yields an identity token
   (an RS256 JWT audienced to our bundle id), which the server verifies
   against Apple's JWKS at POST /api/auth/apple and swaps for the same
   session token a Google sign-in mints. */

import * as AppleAuthentication from "expo-apple-authentication";
import { parseError } from "../api/client";

/** True when this build can present the native sheet: iOS 13+ with the
    Sign in with Apple entitlement. Dev builds signed by a free personal
    team strip that entitlement (see plugins/withNoPushEntitlement.js), so
    the button simply doesn't render there. */
export async function appleAvailable(): Promise<boolean> {
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

/** Run the native sheet and exchange the identity token for a session.
    Returns null when the user dismissed the sheet; throws on real failures
    (same contract as runGoogleFlow). */
export async function runAppleFlow(baseUrl: string): Promise<string | null> {
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
    });
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_REQUEST_CANCELED") return null;
    throw e;
  }
  if (!credential.identityToken) {
    throw new Error("Apple sign-in did not return a credential");
  }
  const res = await fetch(`${baseUrl}/api/auth/apple`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity_token: credential.identityToken }),
  });
  if (!res.ok) throw await parseError(res);
  const { token } = (await res.json()) as { token: string };
  return token;
}
