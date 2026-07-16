/* TanStack Query hooks for the whole REST surface. Live updates arrive via
   the WS reducer; these hooks own initial fetches, pagination and writes. */

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { File as FSFile } from "expo-file-system";
import { useEffect } from "react";
import { keys } from "./keys";
import { useApi } from "../state/session";
import { useLive } from "../state/live";
import { appendMessage, applyMessageToGroups, replaceMessage, type MessagePages } from "../ws/reducer";
import type {
  AgentInfo,
  AskResponse,
  ChannelActivity,
  ChannelAgent,
  Connection,
  Group,
  Me,
  Member,
  Message,
  PairingToken,
  PinnedMessage,
  SearchResponse,
  StarredMessage,
  ThreadRow,
} from "./types";

const PAGE_SIZE = 50;

/* ------------------------------------------------------------- me */

/** Server capabilities (`voice`, `search_ai`) + identity. Rarely changes
    within a session, so cache it for a long while. */
export function useMe() {
  const api = useApi();
  return useQuery({
    queryKey: keys.me,
    queryFn: () => api.get<Me>("/api/me"),
    staleTime: 5 * 60_000,
  });
}

/* ------------------------------------------------------------- groups */

export function useGroups() {
  const api = useApi();
  return useQuery({
    queryKey: keys.groups,
    queryFn: async () => (await api.get<{ groups: Group[] }>("/api/groups")).groups,
  });
}

export function useCreateGroup() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; description?: string }) =>
      api.post<Group>("/api/groups", v),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.groups }),
  });
}

export function useDeleteGroup() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) => api.delete(`/api/groups/${groupId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.groups }),
  });
}

/** Hide (or show) a group in the home list — presentation only. */
export function useSetGroupHidden() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { groupId: string; hidden: boolean }) =>
      api.patch(`/api/groups/${v.groupId}`, { hidden: v.hidden }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.groups }),
  });
}

export function useCreateChannel() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { groupId: string; name: string; topic?: string }) =>
      api.post(`/api/groups/${v.groupId}/channels`, { name: v.name, topic: v.topic }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.groups }),
  });
}

export function useUpdateChannel() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      groupId: string;
      channelId: string;
      name?: string;
      topic?: string;
      hidden?: boolean;
    }) =>
      api.patch(`/api/groups/${v.groupId}/channels/${v.channelId}`, {
        name: v.name,
        topic: v.topic,
        hidden: v.hidden,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.groups });
      void qc.invalidateQueries({ queryKey: keys.threads });
    },
  });
}

export function useDeleteChannel() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { groupId: string; channelId: string }) =>
      api.delete(`/api/groups/${v.groupId}/channels/${v.channelId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.groups }),
  });
}

/* ------------------------------------------------------------- members */

export function useMembers(groupId: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.members(groupId),
    queryFn: async () =>
      (await api.get<{ members: Member[] }>(`/api/groups/${groupId}/members`)).members,
  });
}

export function useAddMember(groupId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      member_type: "user" | "agent";
      member_id: string;
      role?: string;
      channel_id?: string;
    }) => api.post(`/api/groups/${groupId}/members`, v),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.members(groupId) });
      // Mention chips + "no agents" banners key off the per-channel agent list.
      void qc.invalidateQueries({ queryKey: ["channelAgents"] });
    },
  });
}

export function useRemoveMember(groupId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { member_type: string; member_id: string; channel_id?: string | null }) =>
      api.delete(
        `/api/groups/${groupId}/members/${v.member_type}/${encodeURIComponent(v.member_id)}` +
          (v.channel_id ? `?channel_id=${encodeURIComponent(v.channel_id)}` : ""),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.members(groupId) });
      void qc.invalidateQueries({ queryKey: ["channelAgents"] });
    },
  });
}

/* ------------------------------------------------------------- messages */

/** Pages of a channel's top level (threadId null) or one thread.
    pages[0] is the newest page; each page is newest-last (server order). */
export function useMessages(channelId: string, threadId: number | null) {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.messages(channelId, threadId),
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (threadId != null) params.set("thread_id", String(threadId));
      if (pageParam) params.set("before_id", String(pageParam));
      const r = await api.get<{ messages: Message[] }>(
        `/api/channels/${channelId}/messages?${params}`,
      );
      return r.messages;
    },
    initialPageParam: undefined as number | undefined,
    // Older page cursor: the oldest id we have. A short page means we hit
    // the start of history.
    getNextPageParam: (lastPage) =>
      lastPage.length < PAGE_SIZE ? undefined : lastPage[0]?.id,
  });
}

/** Flatten pages into chronological (oldest-first) order. */
export function flattenMessages(data: MessagePages | undefined): Message[] {
  if (!data) return [];
  return [...data.pages].reverse().flat();
}

export interface OutgoingFile {
  uri: string;
  name: string;
  type: string;
}

/** Expo's global fetch (SDK 54+) only serializes real Blob/File multipart
    parts — RN's {uri, name, type} descriptors throw "Unsupported
    FormDataPart implementation". expo-file-system's File wraps the local
    uri as a Blob and carries the filename the server needs. */
function formFile(f: OutgoingFile): Blob {
  return new FSFile(f.uri) as unknown as Blob;
}

/** Sender's IANA timezone, attached hidden to every outgoing message so
    agents can reason about the user's local time. Never rendered in chat. */
function clientTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

export function useSendMessage(channelId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      text: string;
      threadId: number | null;
      files?: OutgoingFile[];
    }) => {
      const tz = clientTimezone();
      if (v.files && v.files.length > 0) {
        const form = new FormData();
        form.append("text", v.text);
        if (v.threadId != null) form.append("thread_id", String(v.threadId));
        if (tz) form.append("timezone", tz);
        for (const f of v.files) {
          form.append("files", formFile(f));
        }
        return api.upload<Message>(`/api/channels/${channelId}/messages/upload`, form);
      }
      return api.post<Message>(`/api/channels/${channelId}/messages`, {
        text: v.text,
        thread_id: v.threadId,
        ...(tz ? { timezone: tz } : {}),
      });
    },
    onSuccess: (message, v) => {
      // The WS echo will dedupe against this append.
      qc.setQueryData<MessagePages>(
        keys.messages(channelId, v.threadId),
        (data) => appendMessage(data, message),
      );
      qc.setQueryData<Group[]>(keys.groups, (groups) =>
        applyMessageToGroups(groups, message, message.author_id),
      );
    },
  });
}

export function useSelectOption() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { messageId: number; optionId: string }) =>
      api.post<Message>(`/api/messages/${v.messageId}/select`, {
        option_id: v.optionId,
      }),
    onSuccess: (message) => {
      qc.setQueryData<MessagePages>(
        keys.messages(message.channel_id, message.thread_id),
        (data) => replaceMessage(data, message),
      );
    },
  });
}

/** Voice note / live-voice turn: upload a recording, the server transcribes
    it and posts the transcript as a normal user message (returned here).
    `live` steers member agents to answer in spoken prose. `mentions` is the
    composer's "talk to" prefix ("@a, @b") — the server prepends it to the
    transcript so voice turns address agents like typed messages do. */
export function useSendVoice(channelId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      file: OutgoingFile;
      threadId: number | null;
      live?: boolean;
      mentions?: string;
    }) => {
      const form = new FormData();
      form.append("file", formFile(v.file));
      if (v.threadId != null) form.append("thread_id", String(v.threadId));
      if (v.live) form.append("live", "true");
      if (v.mentions) form.append("mentions", v.mentions);
      const tz = clientTimezone();
      if (tz) form.append("timezone", tz);
      return api.upload<Message>(`/api/channels/${channelId}/voice`, form);
    },
    onSuccess: (message, v) => {
      qc.setQueryData<MessagePages>(
        keys.messages(channelId, v.threadId),
        (data) => appendMessage(data, message),
      );
      qc.setQueryData<Group[]>(keys.groups, (groups) =>
        applyMessageToGroups(groups, message, message.author_id),
      );
    },
  });
}

export function useMarkRead(channelId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: (lastReadId: number | null) =>
      api.put<{ ok: boolean; last_read_id: number }>(
        `/api/channels/${channelId}/read`,
        { last_read_id: lastReadId },
      ),
    // Groups cache is patched by the WS "read" echo.
  });
}

/* ------------------------------------------------------------- search */

/** Optional search scope: restrict message hits (and Ask-AI) to one channel
    or one whole group. Both unset = everywhere. */
export interface SearchScope {
  channelId?: string;
  groupId?: string;
}

/** Stable cache-key fragment for a scope, so switching filters re-fetches. */
function scopeKey(scope?: SearchScope): string {
  if (scope?.channelId) return `c:${scope.channelId}`;
  if (scope?.groupId) return `g:${scope.groupId}`;
  return "";
}

/** `&channel_id=…` / `&group_id=…` suffix for GET /api/search. */
function scopeQuery(scope?: SearchScope): string {
  let s = "";
  if (scope?.channelId) s += `&channel_id=${encodeURIComponent(scope.channelId)}`;
  if (scope?.groupId) s += `&group_id=${encodeURIComponent(scope.groupId)}`;
  return s;
}

/** Attachment filter: "" = any content, "any" = only messages with files, or
    one kind. An active filter lets the search run with an empty query
    (browse every message carrying a matching attachment). */
export type FileFilter = "" | "any" | "image" | "pdf" | "doc" | "video" | "audio";

/** `&has_files=1` / `&file_type=…` suffix for GET /api/search, "" when off. */
function fileQuery(file?: FileFilter): string {
  if (file === "any") return "&has_files=1";
  if (file) return `&file_type=${encodeURIComponent(file)}`;
  return "";
}

/** First page of GET /api/search for `q`. `keepPreviousData` holds the last
    results on screen while a retyped query is in flight. */
export function useSearch(q: string, scope?: SearchScope, file?: FileFilter) {
  const api = useApi();
  return useQuery({
    queryKey: keys.search(q, scopeKey(scope), file ?? ""),
    queryFn: () =>
      api.get<SearchResponse>(
        `/api/search?q=${encodeURIComponent(q)}${scopeQuery(scope)}${fileQuery(file)}`,
      ),
    // A file filter alone (empty query) is a valid "browse files" search.
    enabled: q.trim().length > 0 || !!file,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
}

/** Imperative "More results" page fetch; the screen accumulates the pages
    in local state, so this is a mutation rather than a keyed query. */
export function useSearchMore() {
  const api = useApi();
  return useMutation({
    mutationFn: async (v: {
      q: string;
      offset: number;
      scope?: SearchScope;
      file?: FileFilter;
    }) =>
      (
        await api.get<SearchResponse>(
          `/api/search?q=${encodeURIComponent(v.q)}&offset=${v.offset}&types=messages${scopeQuery(v.scope)}${fileQuery(v.file)}`,
        )
      ).messages,
  });
}

/** POST /api/search/ask — AI answer with [n] citations into `sources`.
    Only offered when /api/me reports `search_ai`. */
export function useAskAi() {
  const api = useApi();
  return useMutation({
    mutationFn: (v: { q: string; scope?: SearchScope }) =>
      api.post<AskResponse>("/api/search/ask", {
        q: v.q,
        ...(v.scope?.channelId ? { channel_id: v.scope.channelId } : {}),
        ...(v.scope?.groupId ? { group_id: v.scope.groupId } : {}),
      }),
  });
}

/* ------------------------------------------------------------- threads */

/** The threads inbox: every thread the user participates in, newest first.
    Live updates arrive via the WS reducer. */
export function useThreads() {
  const api = useApi();
  return useQuery({
    queryKey: keys.threads,
    queryFn: async () =>
      (await api.get<{ threads: ThreadRow[] }>("/api/threads?limit=100")).threads,
  });
}

/** Single message fetch — the thread screen's root fallback when the root
    isn't in the loaded top-level window (inbox, notification, deep link). */
export function useMessage(messageId: number, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: keys.message(messageId),
    queryFn: () => api.get<Message>(`/api/messages/${messageId}`),
    enabled,
  });
}

/** Dismiss a thread from the inbox — the channel keeps its messages. */
export function useHideThread() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (threadId: number) => api.put(`/api/threads/${threadId}/hide`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.threads }),
  });
}

/** Rename a thread with a display alias (empty string clears it back to the
    root message's first line). The threads cache is patched by the WS
    "thread_renamed" echo; invalidate as a fallback. */
export function useRenameThread() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { threadId: number; alias: string }) =>
      api.patch(`/api/threads/${v.threadId}`, { alias: v.alias }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.threads }),
  });
}

export function useMarkThreadRead(threadId: number) {
  const api = useApi();
  return useMutation({
    mutationFn: (lastReadId: number | null) =>
      api.put<{ ok: boolean; last_read_id: number }>(
        `/api/threads/${threadId}/read`,
        { last_read_id: lastReadId },
      ),
    // Threads cache is patched by the WS "thread_read" echo.
  });
}

/* ------------------------------------------------------------- pins & stars */

export function usePins(channelId: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.pins(channelId),
    queryFn: async () =>
      (await api.get<{ pins: PinnedMessage[] }>(`/api/channels/${channelId}/pins`)).pins,
  });
}

export function usePinMessage(channelId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { messageId: number; pinned: boolean }) =>
      v.pinned
        ? api.put(`/api/channels/${channelId}/pins/${v.messageId}`)
        : api.delete(`/api/channels/${channelId}/pins/${v.messageId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.pins(channelId) }),
  });
}

export function useStars(channelId: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.stars(channelId),
    queryFn: async () =>
      (await api.get<{ stars: StarredMessage[] }>(`/api/channels/${channelId}/stars`)).stars,
  });
}

export function useStarMessage(channelId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { messageId: number; starred: boolean }) =>
      v.starred
        ? api.put(`/api/channels/${channelId}/stars/${v.messageId}`)
        : api.delete(`/api/channels/${channelId}/stars/${v.messageId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.stars(channelId) }),
  });
}

/* ------------------------------------------------------------- agents & activity */

export function useChannelAgents(channelId: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.channelAgents(channelId),
    queryFn: async () =>
      (await api.get<{ agents: ChannelAgent[] }>(`/api/channels/${channelId}/agents`)).agents,
  });
}

/** Fetch in-flight typing/progress once per channel open and seed the live
    store; afterwards WS frames keep it current. */
export function useSeedActivity(channelId: string) {
  const api = useApi();
  const query = useQuery({
    queryKey: keys.activity(channelId),
    queryFn: () => api.get<ChannelActivity>(`/api/channels/${channelId}/activity`),
    staleTime: Infinity,
  });
  const seed = useLive((s) => s.seed);
  useEffect(() => {
    if (query.data) seed(channelId, query.data);
  }, [channelId, query.data, seed]);
}

export function useAgents() {
  const api = useApi();
  return useQuery({
    queryKey: keys.agents,
    queryFn: async () =>
      (await api.get<{ agents: AgentInfo[] }>("/api/agents")).agents,
  });
}

export function useForgetAgent() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => api.delete(`/api/agents/${encodeURIComponent(agentId)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.agents }),
  });
}

/* ------------------------------------------------------------- connections & pairing */

/** Poll while the settings screen is open, like the desktop pane (4s). */
export function useConnections(poll = false) {
  const api = useApi();
  return useQuery({
    queryKey: keys.connections,
    queryFn: async () =>
      (await api.get<{ connections: Connection[] }>("/api/connections")).connections,
    refetchInterval: poll ? 4000 : false,
  });
}

export function useConnectionMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: keys.connections });
  return {
    add: useMutation({
      mutationFn: (v: { name: string; url: string; token: string }) =>
        api.post("/api/connections", v),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: (v: { name: string; url?: string; token?: string; enabled?: boolean }) =>
        api.put(`/api/connections/${encodeURIComponent(v.name)}`, v),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (name: string) =>
        api.delete(`/api/connections/${encodeURIComponent(name)}`),
      onSuccess: invalidate,
    }),
  };
}

export function usePairingTokens() {
  const api = useApi();
  return useQuery({
    queryKey: keys.pairing,
    queryFn: async () =>
      (await api.get<{ tokens: PairingToken[] }>("/api/pairing")).tokens,
  });
}

export function usePairingMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: keys.pairing });
  return {
    create: useMutation({
      mutationFn: (name: string) => api.post<{ token: string }>("/api/pairing", { name }),
      onSuccess: invalidate,
    }),
    revoke: useMutation({
      mutationFn: (token: string) => api.delete(`/api/pairing/${encodeURIComponent(token)}`),
      onSuccess: invalidate,
    }),
  };
}
