import {
  ApiClient,
  ApiError,
  normalizeBaseUrl,
  originOf,
  wsUrl,
  fileUrl,
} from "@agora/core";

describe("normalizeBaseUrl", () => {
  it("defaults LAN/loopback hosts to http", () => {
    expect(normalizeBaseUrl("192.168.1.10:8890")).toBe("http://192.168.1.10:8890");
    expect(normalizeBaseUrl("localhost:4470")).toBe("http://localhost:4470");
    expect(normalizeBaseUrl("my-mac.local:4470")).toBe("http://my-mac.local:4470");
  });
  it("defaults public hosts to https (plain-http would break the ws upgrade)", () => {
    expect(normalizeBaseUrl("agoras.up.railway.app")).toBe("https://agoras.up.railway.app");
  });
  it("strips trailing slashes and keeps https", () => {
    expect(normalizeBaseUrl("https://agora.example.com/")).toBe("https://agora.example.com");
  });
});

describe("originOf", () => {
  it("takes the origin of the final redirected URL", () => {
    expect(originOf("https://agoras.up.railway.app/api/me", "http://x")).toBe(
      "https://agoras.up.railway.app",
    );
  });
  it("falls back when fetch reports no url", () => {
    expect(originOf(undefined, "http://fallback")).toBe("http://fallback");
  });
});

describe("wsUrl / fileUrl", () => {
  const session = { baseUrl: "https://agora.example.com", token: "t0k&n" };
  it("swaps scheme and rides the token as a query param (browser-style WS auth)", () => {
    expect(wsUrl(session)).toBe("wss://agora.example.com/ws?token=t0k%26n");
  });
  it("builds file urls", () => {
    expect(fileUrl(session, "abc123")).toBe("https://agora.example.com/api/files/abc123");
  });
});

describe("ApiClient error handling", () => {
  const session = { baseUrl: "http://x", token: "t" };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("unwraps the server's {detail} error shape", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Unknown channel" }), { status: 404 }),
    );
    const err = (await new ApiClient(session)
      .get("/api/channels/x/messages")
      .catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("Unknown channel");
  });

  it("falls back to the raw body for non-JSON errors", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(new Response("bad token", { status: 401 }));
    const err = (await new ApiClient(session).get("/api/me").catch((e) => e)) as ApiError;
    expect(err.status).toBe(401);
    expect(err.message).toBe("bad token");
  });

  it("sends the bearer header and JSON content type on writes", async () => {
    const spy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await new ApiClient(session).post("/api/groups", { name: "x" });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("http://x/api/groups");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer t");
    expect((init!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});
