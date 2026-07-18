/* The recent-servers MRU list: deduped, most-recent-first, capped, and
   robust against a corrupt keychain value. */

const mockKv = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async (key: string) => mockKv.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockKv.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockKv.delete(key);
  }),
}));

import {
  KEY_RECENT,
  forgetRecentServer,
  loadRecentServers,
  rememberServer,
} from "../src/state/servers";

beforeEach(() => {
  mockKv.clear();
  jest.clearAllMocks();
});

describe("rememberServer", () => {
  it("fronts new entries and dedupes normalized URLs", async () => {
    await rememberServer("https://a.example");
    await rememberServer("https://b.example/");
    const list = await rememberServer(" https://a.example ");
    expect(list).toEqual(["https://a.example", "https://b.example"]);
    expect(await loadRecentServers()).toEqual(list);
  });

  it("caps the list at eight", async () => {
    for (let i = 0; i < 12; i++) await rememberServer(`https://s${i}.example`);
    const list = await loadRecentServers();
    expect(list).toHaveLength(8);
    expect(list[0]).toBe("https://s11.example");
    expect(list[7]).toBe("https://s4.example");
  });

  it("ignores empty input", async () => {
    expect(await rememberServer("  ")).toEqual([]);
    expect(mockKv.has(KEY_RECENT)).toBe(false);
  });
});

describe("forgetRecentServer", () => {
  it("removes one entry and persists the rest", async () => {
    await rememberServer("https://a.example");
    await rememberServer("https://b.example");
    expect(await forgetRecentServer("https://a.example/")).toEqual(["https://b.example"]);
    expect(await loadRecentServers()).toEqual(["https://b.example"]);
  });
});

describe("loadRecentServers", () => {
  it("survives a corrupt or non-array stored value", async () => {
    mockKv.set(KEY_RECENT, "not json");
    expect(await loadRecentServers()).toEqual([]);
    mockKv.set(KEY_RECENT, '{"nope":1}');
    expect(await loadRecentServers()).toEqual([]);
    mockKv.set(KEY_RECENT, '["https://a.example", 42, ""]');
    expect(await loadRecentServers()).toEqual(["https://a.example"]);
  });
});
