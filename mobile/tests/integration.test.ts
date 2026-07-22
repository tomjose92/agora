/**
 * @jest-environment node
 */

/* Integration: the app's own ApiClient + WS frames against a real
   agora-server. This is what keeps the hand-written TS payload types honest
   (there is no shared schema with the Rust server).

   Run with: npm run test:integration
   - Uses AGORA_TEST_URL + AGORA_TEST_TOKEN when provided,
   - otherwise spawns the repo's agora-server (a prebuilt target/ binary if
     present, else `cargo run -p agora-server`) with a temp data dir.

   Requires Node's global fetch/FormData/WebSocket (Node >= 22). */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient, ApiError, wsUrl, type Session } from "@agora/core";
import type { Group, Me, Message, PinnedMessage, StarredMessage } from "@agora/core";

const RUN = process.env.AGORA_INTEGRATION === "1";
const d = RUN ? describe : describe.skip;

const REPO_ROOT = join(__dirname, "..", "..");

interface Server {
  session: Session;
  child: ChildProcess | null;
  dataDir: string | null;
}

async function startServer(): Promise<Server> {
  if (process.env.AGORA_TEST_URL && process.env.AGORA_TEST_TOKEN) {
    return {
      session: { baseUrl: process.env.AGORA_TEST_URL, token: process.env.AGORA_TEST_TOKEN },
      child: null,
      dataDir: null,
    };
  }
  const prebuilt = ["release", "debug"]
    .map((p) => join(REPO_ROOT, "target", p, "agora-server"))
    .find(existsSync);

  // Pin a random high port via config.json (a desktop Agora often holds the
  // default 4470); retry a couple of times in case of a collision.
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const dataDir = mkdtempSync(join(tmpdir(), "agora-itest-"));
    const port = 20_000 + Math.floor(Math.random() * 40_000);
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ port }));
    const child = prebuilt
      ? spawn(prebuilt, ["--data-dir", dataDir], { cwd: REPO_ROOT })
      : spawn("cargo", ["run", "-q", "-p", "agora-server", "--", "--data-dir", dataDir], {
          cwd: REPO_ROOT,
        });

    // The server prints its bound address and admin key on boot.
    try {
      const session = await new Promise<Session>((resolve, reject) => {
        let out = "";
        const timeout = setTimeout(
          () => reject(new Error(`agora-server didn't start; output so far:\n${out}`)),
          240_000,
        );
        timeout.unref();
        const scan = () => {
          const addr = /Agora ready at (http:\/\/[^\s]+)/.exec(out);
          const token = /Admin key: ([0-9a-f]+)/.exec(out);
          if (addr && token) {
            clearTimeout(timeout);
            resolve({ baseUrl: addr[1], token: token[1] });
          }
        };
        child.stdout!.on("data", (b: Buffer) => {
          out += b.toString();
          scan();
        });
        child.stderr!.on("data", (b: Buffer) => {
          out += b.toString();
        });
        child.on("exit", (code) => reject(new Error(`agora-server exited ${code}:\n${out}`)));
      });
      return { session, child, dataDir };
    } catch (e) {
      child.kill();
      rmSync(dataDir, { recursive: true, force: true });
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`could not start agora-server: ${lastErr}`);
}

d("agora-server integration", () => {
  let server: Server;
  let api: ApiClient;
  let group: Group;
  let channelId: string;

  beforeAll(async () => {
    server = await startServer();
    api = new ApiClient(server.session);
  }, 250_000);

  afterAll(() => {
    server?.child?.kill();
    if (server?.dataDir) rmSync(server.dataDir, { recursive: true, force: true });
  });

  it("authenticates via /api/me and rejects bad tokens", async () => {
    const me = await api.get<Me>("/api/me");
    expect(typeof me.username).toBe("string");
    expect(typeof me.version).toBe("string");

    const bad = new ApiClient({ ...server.session, token: "nope" });
    const err = (await bad.get("/api/me").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
  });

  it("creates a group with the embedded channels/role shape", async () => {
    group = await api.post<Group>("/api/groups", { name: "itest", description: "d" });
    expect(group.role).toBe("admin");
    expect(Array.isArray(group.channels)).toBe(true);
  });

  it("creates a channel and lists it with unread metadata", async () => {
    const ch = await api.post<{ id: string }>(`/api/groups/${group.id}/channels`, {
      name: "general",
    });
    channelId = ch.id;
    const { groups } = await api.get<{ groups: Group[] }>("/api/groups");
    const mine = groups.find((g) => g.id === group.id)!;
    const c = mine.channels.find((x) => x.id === channelId)!;
    expect(c.unread).toBe(0);
    expect(typeof c.last_read_id).toBe("number");
  });

  it("posts and lists messages with the exact Message shape", async () => {
    const posted = await api.post<Message>(`/api/channels/${channelId}/messages`, {
      text: "hello **world**",
      thread_id: null,
    });
    expect(posted).toMatchObject({
      channel_id: channelId,
      thread_id: null,
      author_type: "user",
      text: "hello **world**",
      attachments: [],
    });
    expect(typeof posted.id).toBe("number");
    expect(typeof posted.ts).toBe("number");

    const { messages } = await api.get<{ messages: Message[] }>(
      `/api/channels/${channelId}/messages?limit=50`,
    );
    const found = messages.find((m) => m.id === posted.id)!;
    expect(found.reply_count).toBe(0);
  });

  it("threads: replies land under the root and bump reply_count", async () => {
    const root = await api.post<Message>(`/api/channels/${channelId}/messages`, {
      text: "root",
      thread_id: null,
    });
    const reply = await api.post<Message>(`/api/channels/${channelId}/messages`, {
      text: "reply",
      thread_id: root.id,
    });
    expect(reply.thread_id).toBe(root.id);

    // Replying to a reply folds back to the root (resolve_thread).
    const nested = await api.post<Message>(`/api/channels/${channelId}/messages`, {
      text: "nested",
      thread_id: reply.id,
    });
    expect(nested.thread_id).toBe(root.id);

    const { messages: thread } = await api.get<{ messages: Message[] }>(
      `/api/channels/${channelId}/messages?thread_id=${root.id}`,
    );
    expect(thread.map((m) => m.text)).toEqual(["reply", "nested"]);

    const { messages: top } = await api.get<{ messages: Message[] }>(
      `/api/channels/${channelId}/messages`,
    );
    expect(top.find((m) => m.id === root.id)!.reply_count).toBe(2);
  });

  it("paginates with before_id", async () => {
    for (let i = 0; i < 5; i++) {
      await api.post(`/api/channels/${channelId}/messages`, { text: `p${i}`, thread_id: null });
    }
    const { messages: page1 } = await api.get<{ messages: Message[] }>(
      `/api/channels/${channelId}/messages?limit=3`,
    );
    expect(page1).toHaveLength(3);
    const { messages: page2 } = await api.get<{ messages: Message[] }>(
      `/api/channels/${channelId}/messages?limit=3&before_id=${page1[0].id}`,
    );
    expect(page2.every((m) => m.id < page1[0].id)).toBe(true);
  });

  it("uploads multipart attachments and serves the file back", async () => {
    const form = new FormData();
    form.append("text", "with file");
    form.append("files", new Blob([Buffer.from("file-bytes")], { type: "text/plain" }), "a.txt");
    const posted = await api.upload<Message>(
      `/api/channels/${channelId}/messages/upload`,
      form as unknown as FormData,
    );
    expect(posted.attachments).toHaveLength(1);
    expect(posted.attachments[0]).toMatchObject({ filename: "a.txt", mime: "text/plain", size: 10 });

    const res = await fetch(`${server.session.baseUrl}/api/files/${posted.attachments[0].id}`, {
      headers: { Authorization: `Bearer ${server.session.token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("file-bytes");
  });

  it("read markers are monotonic", async () => {
    const r1 = await api.put<{ last_read_id: number }>(`/api/channels/${channelId}/read`, {
      last_read_id: null,
    });
    const r2 = await api.put<{ last_read_id: number }>(`/api/channels/${channelId}/read`, {
      last_read_id: 1,
    });
    expect(r2.last_read_id).toBe(r1.last_read_id); // never moves backwards
  });

  it("stars and pins round-trip (and reject pinning a reply)", async () => {
    const root = await api.post<Message>(`/api/channels/${channelId}/messages`, {
      text: "pin me",
      thread_id: null,
    });
    const reply = await api.post<Message>(`/api/channels/${channelId}/messages`, {
      text: "reply",
      thread_id: root.id,
    });

    await api.put(`/api/channels/${channelId}/stars/${reply.id}`);
    const { stars } = await api.get<{ stars: StarredMessage[] }>(
      `/api/channels/${channelId}/stars`,
    );
    const star = stars.find((s) => s.id === reply.id)!;
    expect(star.root!.id).toBe(root.id); // starred replies carry their root
    await api.delete(`/api/channels/${channelId}/stars/${reply.id}`);

    await api.put(`/api/channels/${channelId}/pins/${root.id}`);
    const { pins } = await api.get<{ pins: PinnedMessage[] }>(`/api/channels/${channelId}/pins`);
    expect(pins.map((p) => p.id)).toContain(root.id);

    const err = (await api
      .put(`/api/channels/${channelId}/pins/${reply.id}`)
      .catch((e) => e)) as ApiError;
    expect(err.status).toBe(400);
    await api.delete(`/api/channels/${channelId}/pins/${root.id}`);
  });

  it("streams message frames over /ws", async () => {
    const ws = new WebSocket(wsUrl(server.session));
    const frames: unknown[] = [];
    const gotMessage = new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no message frame; saw ${JSON.stringify(frames)}`)), 10_000);
      ws.onmessage = (e) => {
        const frame = JSON.parse(String(e.data));
        frames.push(frame);
        if (frame.type === "message" && frame.message?.text === "over the wire") {
          clearTimeout(t);
          resolve(frame);
        }
      };
      ws.onerror = () => reject(new Error("ws error"));
    });
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    await api.post(`/api/channels/${channelId}/messages`, {
      text: "over the wire",
      thread_id: null,
    });
    const frame = await gotMessage;
    expect((frame.message as Message).channel_id).toBe(channelId);
    ws.close();
  });

  it("rejects a websocket with a bad token", async () => {
    const ws = new WebSocket(`${wsUrl({ ...server.session, token: "bad" })}`);
    const outcome = await new Promise<string>((resolve) => {
      ws.onopen = () => resolve("open");
      ws.onerror = () => resolve("error");
      ws.onclose = () => resolve("closed");
    });
    expect(outcome).not.toBe("open");
  });
});
