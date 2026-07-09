/* TanStack Query hooks for the whole REST surface. Live updates arrive via
   the WS reducer; these hooks own initial fetches, pagination and writes. */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { keys } from "./keys";
import { useApi } from "../state/session";
import { useLive } from "../state/live";
import { appendMessage, applyMessageToGroups, type MessagePages } from "../ws/reducer";
import type {
  AgentInfo,
  ChannelActivity,
  ChannelAgent,
  Connection,
  Group,
  Member,
  Message,
  PairingToken,
  PinnedMessage,
  StarredMessage,
  ThreadRow,
} from "./types";

const PAGE_SIZE = 50;

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
    mutationFn: (v: { groupId: string; channelId: string; name?: string; topic?: string }) =>
      api.patch(`/api/groups/${v.groupId}/channels/${v.channelId}`, {
        name: v.name,
        topic: v.topic,
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

export function useSendMessage(channelId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      text: string;
      threadId: number | null;
      files?: OutgoingFile[];
    }) => {
      if (v.files && v.files.length > 0) {
        const form = new FormData();
        form.append("text", v.text);
        if (v.threadId != null) form.append("thread_id", String(v.threadId));
        for (const f of v.files) {
          // RN's FormData takes {uri, name, type} descriptors for files.
          form.append("files", f as unknown as Blob);
        }
        return api.upload<Message>(`/api/channels/${channelId}/messages/upload`, form);
      }
      return api.post<Message>(`/api/channels/${channelId}/messages`, {
        text: v.text,
        thread_id: v.threadId,
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
