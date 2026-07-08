/* Thin fetch wrapper over the agora-server REST API (server.rs).
   All errors come back as {detail}; auth is a single owner bearer token. */

export class ApiError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

export interface Session {
  baseUrl: string; // e.g. "https://agora.example.com" — no trailing slash
  token: string;
}

/** "host:port" or bare URLs become fully-qualified http(s) origins. */
export function normalizeBaseUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url;
}

export function wsUrl(session: Session): string {
  const base = session.baseUrl.replace(/^http/i, "ws");
  return `${base}/ws?token=${encodeURIComponent(session.token)}`;
}

export function fileUrl(session: Session, fileId: string): string {
  return `${session.baseUrl}/api/files/${encodeURIComponent(fileId)}`;
}

export function authHeaders(session: Session): Record<string, string> {
  return { Authorization: `Bearer ${session.token}` };
}

async function parseError(res: Response): Promise<ApiError> {
  let detail = await res.text();
  try {
    detail = JSON.parse(detail).detail || detail;
  } catch {
    /* plain-text error body */
  }
  return new ApiError(res.status, detail || res.statusText);
}

export class ApiClient {
  constructor(private session: Session) {}

  get base(): string {
    return this.session.baseUrl;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const res = await fetch(`${this.session.baseUrl}${path}`, {
      ...init,
      headers: {
        ...authHeaders(this.session),
        ...(init.body && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...(init.headers || {}),
      },
    });
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "PUT",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "DELETE" });
  }

  /** Multipart message post: text + up to 5 files (server-enforced). */
  upload<T>(path: string, form: FormData): Promise<T> {
    return this.request<T>(path, { method: "POST", body: form });
  }
}
