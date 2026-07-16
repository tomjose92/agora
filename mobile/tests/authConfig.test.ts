import { authMethods, probeAuth } from "../src/lib/authConfig";

/* Response's url property is read-only and empty in jest; a plain object
   with the fields the code reads stands in for the redirected fetch. */
function resp(body: unknown, status = 200, url = ""): Response {
  return {
    ok: status < 400,
    status,
    url,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => jest.restoreAllMocks());

describe("probeAuth", () => {
  it("reports methods and the origin the server actually answered from", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      resp(
        { google: { enabled: true }, apple: { enabled: false } },
        200,
        "https://agoras.up.railway.app/api/auth/config",
      ),
    );
    // A stale http:// keychain URL must come back canonicalized to https.
    expect(await probeAuth("http://agoras.up.railway.app")).toEqual({
      google: true,
      apple: false,
      origin: "https://agoras.up.railway.app",
    });
  });

  it("keeps the given origin when fetch reports no final url", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(resp({ google: { enabled: true } }, 200, ""));
    const probe = await probeAuth("https://a.example");
    expect(probe.origin).toBe("https://a.example");
  });

  it("degrades to no methods on HTTP errors and when unreachable", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(resp("nope", 404));
    expect(await probeAuth("https://a.example")).toEqual({
      google: false,
      apple: false,
      origin: "https://a.example",
    });
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("offline"));
    expect(await probeAuth("https://a.example")).toEqual({
      google: false,
      apple: false,
      origin: "https://a.example",
    });
  });
});

describe("authMethods", () => {
  it("is the probe minus the origin", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      resp({ google: { enabled: true }, apple: { enabled: true } }, 200),
    );
    expect(await authMethods("https://a.example")).toEqual({ google: true, apple: true });
  });
});
