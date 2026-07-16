/* signIn's origin canonicalization: the token must ride to the origin the
   server actually answers from, never across a redirect (which strips the
   Authorization header on iOS). */

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

import * as SecureStore from "expo-secure-store";
import { KEY_URL, useSession } from "../src/state/session";

function resp(body: unknown, status = 200, url = ""): Response {
  return {
    ok: status < 400,
    status,
    url,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const me = { username: "tom", voice: false };

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe("signIn", () => {
  it("stores the canonical https origin learned from the probe", async () => {
    jest.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/auth/config")) {
        return resp({ google: { enabled: true } }, 200, "https://a.example/api/auth/config");
      }
      expect(url).toBe("https://a.example/api/me");
      return resp(me, 200, url);
    });
    await useSession.getState().signIn("a.example", "tok");
    const state = useSession.getState();
    expect(state.status).toBe("signedIn");
    expect(state.session).toEqual({ baseUrl: "https://a.example", token: "tok" });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(KEY_URL, "https://a.example");
  });

  it("surfaces a 401 as an error", async () => {
    jest.spyOn(global, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/auth/config")) throw new Error("offline");
      return resp({ detail: "Authentication required" }, 401);
    });
    await expect(
      useSession.getState().signIn("http://192.168.1.10:8890", "bad"),
    ).rejects.toThrow("Authentication required");
  });
});
