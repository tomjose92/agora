import { ApiClient, type Session } from "@agora/core";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "UPLOAD";
type RouteValue = unknown | ((body: unknown) => unknown | Promise<unknown>);

export type FixtureRoutes = Partial<Record<`${Method} ${string}`, RouteValue>>;

const session: Session = { baseUrl: "", token: "storybook" };

/** Runs the production query hooks against deterministic story data. */
export class FixtureApiClient extends ApiClient {
  readonly calls: Array<{ method: Method; path: string; body?: unknown }> = [];

  constructor(private readonly routes: FixtureRoutes = {}) {
    super(session);
  }

  private async resolve<T>(method: Method, path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, body });
    const route = this.routes[`${method} ${path}`];
    if (route === undefined) {
      throw new Error(`Missing Storybook fixture route: ${method} ${path}`);
    }
    return (typeof route === "function" ? await route(body) : route) as T;
  }

  override get<T>(path: string): Promise<T> {
    return this.resolve("GET", path);
  }

  override post<T>(path: string, body?: unknown): Promise<T> {
    return this.resolve("POST", path, body);
  }

  override put<T>(path: string, body?: unknown): Promise<T> {
    return this.resolve("PUT", path, body);
  }

  override patch<T>(path: string, body?: unknown): Promise<T> {
    return this.resolve("PATCH", path, body);
  }

  override delete<T>(path: string, body?: unknown): Promise<T> {
    return this.resolve("DELETE", path, body);
  }

  override upload<T>(path: string, form: FormData, _signal?: AbortSignal): Promise<T> {
    return this.resolve("UPLOAD", path, form);
  }
}
