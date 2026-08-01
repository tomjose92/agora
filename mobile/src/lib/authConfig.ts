/* Which sign-in methods a server offers — the unauthenticated probe of
   GET /api/auth/config that the connect screen runs before rendering
   sign-in buttons. */

import { originOf } from "@agora/core";

export const AUTH_PROBE_TIMEOUT_MS = 5_000;

export interface AuthMethods {
  google: boolean;
  apple: boolean;
  /** Missing on older servers means the backwards-compatible visible form. */
  admin: boolean;
}

export interface AuthProbe extends AuthMethods {
  /** The origin the server actually answered from (after redirects) — a
      stale http:// URL against a host that 301s to https must be replaced
      before any authorized request, which cannot cross a redirect. */
  origin: string;
}

export async function probeAuth(baseUrl: string): Promise<AuthProbe> {
  const none = { google: false, apple: false, admin: true, origin: baseUrl };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/auth/config`, { signal: controller.signal });
    if (!res.ok) return none;
    const cfg = (await res.json()) as {
      google?: { enabled?: boolean };
      apple?: { enabled?: boolean };
      admin?: { enabled?: boolean };
    };
    return {
      google: cfg.google?.enabled === true,
      apple: cfg.apple?.enabled === true,
      admin: cfg.admin?.enabled !== false,
      origin: originOf(res.url, baseUrl),
    };
  } catch {
    return none;
  } finally {
    clearTimeout(timeout);
  }
}

export async function authMethods(baseUrl: string): Promise<AuthMethods> {
  const { google, apple, admin } = await probeAuth(baseUrl);
  return { google, apple, admin };
}
