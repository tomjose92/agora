/* @mention decoration in rendered message HTML — port of agoMd()'s second
   pass in the retired vanilla agora.js: known @tokens become .ago-mention name chips, but
   never inside <pre>/<code>/<a> segments. */

import { esc } from "@agora/core";

export const MENTION_RE = /(^|[\s(>])@([A-Za-z0-9][\w.-]*)/g;

export function slugify(name: string): string {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** key (id or name-slug, lowercased) -> display name */
export type MentionIndex = Record<string, string>;

export function buildMentionIndex(
  agents: { id: string; name: string }[],
  usernames: string[],
): MentionIndex {
  const map: MentionIndex = {};
  const add = (key: string | undefined, name: string) => {
    if (key) map[String(key).toLowerCase()] = name;
  };
  for (const a of agents) {
    add(a.id, a.name);
    add(slugify(a.name), a.name);
  }
  for (const u of usernames) add(u, u);
  return map;
}

export function decorateMentions(html: string, map: MentionIndex): string {
  return html
    .split(/(<pre[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>|<a\b[\s\S]*?<\/a>)/)
    .map((seg, i) => i % 2 ? seg : seg.replace(MENTION_RE, (all, pre, token) => {
      let key = (token as string).toLowerCase(), tail = "";
      while (key && !(key in map) && /[._-]$/.test(key)) {
        tail = key.slice(-1) + tail;
        key = key.slice(0, -1);
      }
      const name = map[key];
      if (!name) return all;
      return `${pre}<span class="ago-mention" title="@${esc(key)}">${esc(name)}</span>${tail}`;
    }))
    .join("");
}
