/* Previously joined servers (URLs only, never tokens): a small MRU list so
   "Change server" can offer past instances instead of a blank field. Lives
   in SecureStore alongside the session keys and deliberately survives
   signOut/forgetServer — that's the whole point of the list. */

import * as SecureStore from "expo-secure-store";

export const KEY_RECENT = "agora_recent_servers";

/** How many previously joined servers to keep around. */
const RECENT_CAP = 8;

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export async function loadRecentServers(): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(KEY_RECENT);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((u): u is string => typeof u === "string" && !!u);
  } catch {
    return [];
  }
}

async function save(urls: string[]): Promise<void> {
  await SecureStore.setItemAsync(KEY_RECENT, JSON.stringify(urls));
}

/** Record a successful connection: front of the list, deduped, capped. */
export async function rememberServer(url: string): Promise<string[]> {
  const normalized = normalize(url);
  if (!normalized) return loadRecentServers();
  const rest = (await loadRecentServers()).filter((u) => u !== normalized);
  const next = [normalized, ...rest].slice(0, RECENT_CAP);
  await save(next);
  return next;
}

/** Drop one entry (user removed it); returns the updated list. */
export async function forgetRecentServer(url: string): Promise<string[]> {
  const normalized = normalize(url);
  const next = (await loadRecentServers()).filter((u) => u !== normalized);
  await save(next);
  return next;
}
