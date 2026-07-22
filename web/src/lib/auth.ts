/* Token/fragment intake — a port of ui/shim.js initToken(), honoring the
   exact same contracts: ?token= from the desktop shell, #agora_session= /
   #auth_error= from the Google round-trip, #join= from /join/{token}. The
   same localStorage key as the vanilla UI, so a sign-in carries across. */

export let AUTH_ERROR = "";
export let JOIN_TOKEN = "";

export function initToken(): void {
  const params = new URLSearchParams(location.search);
  const t = params.get("token");
  if (t) {
    localStorage.setItem("agora_token", t);
    // Drop the token from the visible URL/history.
    history.replaceState(null, "", location.pathname);
  }
  if (location.hash.length > 1) {
    const frag = new URLSearchParams(location.hash.slice(1));
    const session = frag.get("agora_session");
    if (session) localStorage.setItem("agora_token", session);
    AUTH_ERROR = frag.get("auth_error") || "";
    const join = frag.get("join");
    if (join) sessionStorage.setItem("agora_join", join);
    if (session || AUTH_ERROR || join) history.replaceState(null, "", location.pathname);
  }
  JOIN_TOKEN = sessionStorage.getItem("agora_join") || "";
}

export function sessionToken(): string {
  return localStorage.getItem("agora_token") || "";
}

export function setSessionToken(token: string): void {
  localStorage.setItem("agora_token", token);
}

export function clearJoinToken(): void {
  sessionStorage.removeItem("agora_join");
  JOIN_TOKEN = "";
}

export const AUTH_ERROR_TEXT: Record<string, string> = {
  no_access: "That account isn't a member here — ask an admin to invite your email.",
  disabled: "Your account has been disabled on this instance.",
  google_access_denied: "Google sign-in was cancelled.",
  state: "Sign-in expired — try again.",
  invite_invalid: "That invite link has been used or has expired — ask for a new one.",
};
