import { compareVersions, lookupStoreVersion } from "../src/lib/appVersion";

describe("compareVersions", () => {
  it("orders plain dotted versions", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("1.2.0", "1.1.9")).toBeGreaterThan(0);
  });

  it("treats missing segments as zero", () => {
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("2", "1.9.9")).toBeGreaterThan(0);
  });

  it("compares segments numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });
});

describe("lookupStoreVersion", () => {
  const mockFetch = (body: unknown, ok = true, status = 200) => {
    (globalThis as any).fetch = jest.fn(async () => ({
      ok,
      status,
      json: async () => body,
    }));
  };

  afterEach(() => {
    delete (globalThis as any).fetch;
  });

  it("returns the listing version and store URL", async () => {
    mockFetch({
      resultCount: 1,
      results: [{ version: "1.2.0", trackViewUrl: "https://apps.apple.com/app/id123" }],
    });
    await expect(lookupStoreVersion("app.agora.mobile")).resolves.toEqual({
      version: "1.2.0",
      url: "https://apps.apple.com/app/id123",
    });
  });

  it("returns null when there is no listing (pre-publish)", async () => {
    mockFetch({ resultCount: 0, results: [] });
    await expect(lookupStoreVersion("app.agora.mobile")).resolves.toBeNull();
  });

  it("throws on HTTP failure", async () => {
    mockFetch({}, false, 503);
    await expect(lookupStoreVersion("app.agora.mobile")).rejects.toThrow("503");
  });
});
