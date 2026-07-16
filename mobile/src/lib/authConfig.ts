/* Which sign-in methods a server offers — the unauthenticated probe of
   GET /api/auth/config that the connect screen runs before rendering
   sign-in buttons. */

import { originOf } from "../api/client";

export interface AuthMethods {
  google: boolean;
  apple: boolean;
}

export interface AuthProbe extends AuthMethods {
  /** The origin the server actually answered from (after redirects) — a
      stale http:// URL against a host that 301s to https must be replaced
      before any authorized request, which cannot cross a redirect. */
  origin: string;
}

export async function probeAuth(baseUrl: string): Promise<AuthProbe> {
  const none = { google: false, apple: false, origin: baseUrl };
  try {
    const res = await fetch(`${baseUrl}/api/auth/config`);
    if (!res.ok) return none;
    const cfg = (await res.json()) as {
      google?: { enabled?: boolean };
      apple?: { enabled?: boolean };
    };
    return {
      google: cfg.google?.enabled === true,
      apple: cfg.apple?.enabled === true,
      origin: originOf(res.url, baseUrl),
    };
  } catch {
    return none;
  }
}

export async function authMethods(baseUrl: string): Promise<AuthMethods> {
  const { google, apple } = await probeAuth(baseUrl);
  return { google, apple };
}
