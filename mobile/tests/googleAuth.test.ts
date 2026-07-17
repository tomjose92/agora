import { googleEnabled, parseRedirect, signInErrorMessage } from "../src/lib/googleAuth";

describe("parseRedirect", () => {
  it("pulls the session token out of the deep-link redirect", () => {
    expect(parseRedirect("agora://auth?token=eyJ1IjoibWUifQ.c2ln")).toEqual({
      token: "eyJ1IjoibWUifQ.c2ln",
    });
  });
  it("decodes percent-encoding and reads errors", () => {
    expect(parseRedirect("agora://auth?error=google_access_denied")).toEqual({
      error: "google_access_denied",
    });
    expect(parseRedirect("agora://auth?token=a%2Bb")).toEqual({ token: "a+b" });
  });
  it("handles Expo dev-client URLs whose path itself has query-ish parts", () => {
    expect(parseRedirect("exp://192.168.1.5:8081/--/auth?token=t0k")).toEqual({ token: "t0k" });
  });
  it("returns empty for redirects with no query", () => {
    expect(parseRedirect("agora://auth")).toEqual({});
  });
  it("strips the fragment Safari inherits from Google's redirect chain", () => {
    // Regression: an empty trailing `#` was glued onto the token, corrupting
    // it and 401ing every mobile Google sign-in.
    expect(parseRedirect("agora://auth?token=eyJ1IjoibWUifQ.c2ln#")).toEqual({
      token: "eyJ1IjoibWUifQ.c2ln",
    });
    expect(parseRedirect("agora://auth?token=t0k#some=fragment")).toEqual({ token: "t0k" });
  });
});

describe("signInErrorMessage", () => {
  it("humanizes the server's error codes", () => {
    expect(signInErrorMessage("no_access")).toMatch(/isn't invited/);
    expect(signInErrorMessage("disabled")).toMatch(/disabled/);
    expect(signInErrorMessage("google_access_denied")).toMatch(/cancelled/);
    expect(signInErrorMessage("state")).toMatch(/\(state\)/);
    expect(signInErrorMessage(undefined)).toBe("Google sign-in failed");
  });
});

describe("googleEnabled", () => {
  afterEach(() => jest.restoreAllMocks());

  it("is true only when the server reports an enabled google client", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ google: { enabled: true } }), { status: 200 }),
    );
    expect(await googleEnabled("https://a.example")).toBe(true);
  });
  it("is false when disabled, on HTTP errors, and when unreachable", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ google: { enabled: false } }), { status: 200 }),
    );
    expect(await googleEnabled("https://a.example")).toBe(false);
    jest.spyOn(global, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    expect(await googleEnabled("https://a.example")).toBe(false);
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("offline"));
    expect(await googleEnabled("https://a.example")).toBe(false);
  });
});
