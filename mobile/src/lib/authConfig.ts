/* Which sign-in methods a server offers — the unauthenticated probe of
   GET /api/auth/config that the connect screen runs before rendering
   sign-in buttons. */

export interface AuthMethods {
  google: boolean;
  apple: boolean;
}

export async function authMethods(baseUrl: string): Promise<AuthMethods> {
  try {
    const res = await fetch(`${baseUrl}/api/auth/config`);
    if (!res.ok) return { google: false, apple: false };
    const cfg = (await res.json()) as {
      google?: { enabled?: boolean };
      apple?: { enabled?: boolean };
    };
    return {
      google: cfg.google?.enabled === true,
      apple: cfg.apple?.enabled === true,
    };
  } catch {
    return { google: false, apple: false };
  }
}
