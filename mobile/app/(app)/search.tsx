/* Search: one box over groups / channels / messages, mirroring the desktop
   search pane. Message hits show a snippet with the matched terms
   highlighted; tapping a hit opens its channel (or thread — deep-linking to
   the exact message is out of scope). When the server has an Anthropic key
   (me.search_ai), an "Ask Agora AI" row answers questions from history with
   [n] citations into a tappable source list. */

import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, router } from "expo-router";
import { Search as SearchIcon, Sparkles, X } from "lucide-react-native";
import { useAskAi, useMe, useSearch, useSearchMore } from "../../src/api/queries";
import type {
  SearchChannelHit,
  SearchGroupHit,
  SearchMessageHit,
} from "../../src/api/types";
import { Icon } from "../../src/components/Icon";
import { fmtTs } from "../../src/lib/format";
import { colors } from "../../src/lib/theme";

/** Value that lags `value` by `ms` — keeps /api/search off the hot path
    while the user is still typing. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

type Row =
  | { kind: "ask" }
  | { kind: "header"; title: string }
  | { kind: "group"; g: SearchGroupHit }
  | { kind: "channel"; c: SearchChannelHit }
  | { kind: "message"; m: SearchMessageHit }
  | { kind: "more" }
  | { kind: "notice"; text: string };

function rowKey(r: Row): string {
  switch (r.kind) {
    case "ask":
      return "ask";
    case "header":
      return `h:${r.title}`;
    case "group":
      return `g:${r.g.id}`;
    case "channel":
      return `c:${r.c.id}`;
    case "message":
      return `m:${r.m.id}`;
    case "more":
      return "more";
    case "notice":
      return "notice";
  }
}

/** Same push shapes as threads.tsx / index.tsx: thread replies open the
    thread screen, everything else the channel. */
function openHit(m: SearchMessageHit) {
  if (m.thread_id != null) {
    router.push({
      pathname: "/(app)/thread/[channelId]/[rootId]",
      params: {
        channelId: m.channel_id,
        rootId: String(m.thread_id),
        channelName: m.channel_name,
      },
    });
  } else {
    router.push({
      pathname: "/(app)/channel/[id]",
      params: { id: m.channel_id, name: m.channel_name, groupId: m.group_id },
    });
  }
}

/** Server snippets wrap matched terms in U+0001…U+0002; odd split segments
    are the matches. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/[\u0001\u0002]/);
  return (
    <Text style={styles.snippet} numberOfLines={2}>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <Text key={i} style={styles.snippetHit}>
            {p}
          </Text>
        ) : (
          p
        ),
      )}
    </Text>
  );
}

function MessageRow({ hit, badge }: { hit: SearchMessageHit; badge?: number }) {
  return (
    <Pressable style={styles.card} onPress={() => openHit(hit)}>
      <View style={styles.cardTop}>
        {badge != null ? <Text style={styles.citeBadge}>[{badge}]</Text> : null}
        <Text style={styles.author} numberOfLines={1}>
          {hit.author_name || hit.author_id}
        </Text>
        <Text style={styles.ts}>{fmtTs(hit.ts)}</Text>
      </View>
      <Text style={styles.crumb} numberOfLines={1}>
        {hit.group_name ? `${hit.group_name} / ` : ""}
        <Text style={styles.hash}>#</Text>
        {hit.channel_name}
      </Text>
      <Snippet text={hit.snippet} />
    </Pressable>
  );
}

/** Answer text with [n] citations turned into taps on the nth source. */
function AnswerText({
  answer,
  sources,
}: {
  answer: string;
  sources: SearchMessageHit[];
}) {
  const parts = answer.split(/(\[\d+\])/g);
  return (
    <Text style={styles.askAnswer}>
      {parts.map((p, i) => {
        const m = /^\[(\d+)\]$/.exec(p);
        const src = m ? sources[Number(m[1]) - 1] : undefined;
        if (!src) return p;
        return (
          <Text key={i} style={styles.cite} onPress={() => openHit(src)}>
            {p}
          </Text>
        );
      })}
    </Text>
  );
}

export default function SearchScreen() {
  const [input, setInput] = useState("");
  const query = useDebounced(input.trim(), 250);
  const search = useSearch(query);
  const me = useMe();
  const ask = useAskAi();
  const searchMore = useSearchMore();

  /* "More results" pages, appended below the base page. Raw (un-deduped) so
     `offset` stays a plain count of rows fetched; render dedupes by id. */
  const [extra, setExtra] = useState<SearchMessageHit[]>([]);
  const [extraHasMore, setExtraHasMore] = useState<boolean | null>(null);
  useEffect(() => {
    setExtra([]);
    setExtraHasMore(null);
  }, [query]);

  /* Ask-AI card. The question is snapshotted at tap time so further typing
     doesn't change what the card claims to answer. */
  const [askQuestion, setAskQuestion] = useState<string | null>(null);
  const closeAsk = () => {
    setAskQuestion(null);
    ask.reset();
  };
  const startAsk = () => {
    const q = input.trim();
    if (!q) return;
    setAskQuestion(q);
    ask.mutate({ q });
  };

  const data = search.data;
  const groupHits = data?.groups ?? [];
  const channelHits = data?.channels ?? [];
  const baseMessages = useMemo(() => data?.messages?.items ?? [], [data]);
  const messages = useMemo(() => {
    if (extra.length === 0) return baseMessages;
    const seen = new Set(baseMessages.map((m) => m.id));
    const out = [...baseMessages];
    for (const m of extra) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
    }
    return out;
  }, [baseMessages, extra]);
  const hasMore = extraHasMore ?? data?.messages?.has_more ?? false;
  const showAsk = !!me.data?.search_ai && input.trim().length > 0;

  const rows = useMemo<Row[]>(() => {
    if (!query) return [];
    const out: Row[] = [];
    if (showAsk) out.push({ kind: "ask" });
    if (search.isError) {
      out.push({ kind: "notice", text: `Search failed: ${search.error.message}` });
      return out;
    }
    if (!data) return out; // first fetch in flight — header spinner covers it
    if (groupHits.length > 0) {
      out.push({ kind: "header", title: "Groups" });
      for (const g of groupHits) out.push({ kind: "group", g });
    }
    if (channelHits.length > 0) {
      out.push({ kind: "header", title: "Channels" });
      for (const c of channelHits) out.push({ kind: "channel", c });
    }
    if (messages.length > 0) {
      out.push({ kind: "header", title: "Messages" });
      for (const m of messages) out.push({ kind: "message", m });
      if (hasMore) out.push({ kind: "more" });
    }
    if (groupHits.length + channelHits.length + messages.length === 0) {
      out.push({ kind: "notice", text: `No results for “${query}”` });
    }
    return out;
  }, [query, showAsk, search.isError, search.error, data, groupHits, channelHits, messages, hasMore]);

  const onMore = () => {
    if (searchMore.isPending) return;
    const base = data?.messages;
    if (!base) return;
    const offset = base.offset + base.items.length + extra.length;
    searchMore.mutate(
      { q: query, offset },
      {
        onSuccess: (page) => {
          if (!page) return;
          setExtra((prev) => [...prev, ...page.items]);
          setExtraHasMore(page.has_more);
        },
      },
    );
  };

  const renderRow = ({ item }: { item: Row }) => {
    switch (item.kind) {
      case "ask":
        return (
          <Pressable style={styles.askRow} onPress={startAsk}>
            <Icon icon={Sparkles} size={17} color={colors.a1} />
            <Text style={styles.askRowText} numberOfLines={1}>
              Ask Agora AI: <Text style={styles.askRowQuery}>{input.trim()}</Text>
            </Text>
          </Pressable>
        );
      case "header":
        return <Text style={styles.section}>{item.title}</Text>;
      case "group":
        return (
          <Pressable
            style={styles.card}
            onPress={() =>
              router.push({
                pathname: "/(app)/members/[groupId]",
                params: { groupId: item.g.id, name: item.g.name },
              })
            }
          >
            <Text style={styles.title} numberOfLines={1}>
              {item.g.name}
            </Text>
            {item.g.description ? (
              <Text style={styles.sub} numberOfLines={1}>
                {item.g.description}
              </Text>
            ) : null}
          </Pressable>
        );
      case "channel":
        return (
          <Pressable
            style={styles.card}
            onPress={() =>
              router.push({
                pathname: "/(app)/channel/[id]",
                params: { id: item.c.id, name: item.c.name, groupId: item.c.group_id },
              })
            }
          >
            <Text style={styles.title} numberOfLines={1}>
              <Text style={styles.hash}># </Text>
              {item.c.name}
              {item.c.group_name ? (
                <Text style={styles.crumbSuffix}> · {item.c.group_name}</Text>
              ) : null}
            </Text>
            {item.c.topic ? (
              <Text style={styles.sub} numberOfLines={1}>
                {item.c.topic}
              </Text>
            ) : null}
          </Pressable>
        );
      case "message":
        return <MessageRow hit={item.m} />;
      case "more":
        return (
          <Pressable style={styles.moreRow} onPress={onMore} disabled={searchMore.isPending}>
            {searchMore.isPending ? (
              <ActivityIndicator size="small" color={colors.dim} />
            ) : (
              <Text style={styles.moreText}>More results</Text>
            )}
          </Pressable>
        );
      case "notice":
        return <Text style={styles.notice}>{item.text}</Text>;
    }
  };

  const askSources = ask.data?.sources ?? [];

  return (
    <>
      <Stack.Screen options={{ title: "Search", headerShown: true }} />
      <View style={styles.root}>
        <View style={styles.searchRow}>
          <Icon icon={SearchIcon} size={17} color={colors.faint} />
          <TextInput
            style={styles.searchInput}
            value={input}
            onChangeText={setInput}
            placeholder="Search messages, channels, groups"
            placeholderTextColor={colors.faint}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {search.isFetching ? (
            <ActivityIndicator size="small" color={colors.dim} />
          ) : input.length > 0 ? (
            <Pressable onPress={() => setInput("")} hitSlop={8}>
              <Icon icon={X} size={16} color={colors.dim} />
            </Pressable>
          ) : null}
        </View>
        {askQuestion != null ? (
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.askCard}>
              <View style={styles.askHead}>
                <Icon icon={Sparkles} size={16} color={colors.a1} />
                <Text style={styles.askTitle} numberOfLines={2}>
                  {askQuestion}
                </Text>
                <Pressable onPress={closeAsk} hitSlop={10}>
                  <Icon icon={X} size={18} color={colors.dim} />
                </Pressable>
              </View>
              {ask.isPending ? (
                <View style={styles.askThinking}>
                  <ActivityIndicator size="small" color={colors.a1} />
                  <Text style={styles.askThinkingText}>Thinking…</Text>
                </View>
              ) : ask.isError ? (
                <Text style={styles.askError}>{ask.error.message}</Text>
              ) : ask.data ? (
                ask.data.answer ? (
                  <AnswerText answer={ask.data.answer} sources={askSources} />
                ) : (
                  <Text style={styles.notice}>
                    {ask.data.detail || "No matching messages to answer from."}
                  </Text>
                )
              ) : null}
            </View>
            {askSources.length > 0 ? (
              <>
                <Text style={styles.section}>Sources</Text>
                {askSources.map((s, i) => (
                  <MessageRow key={`${s.id}:${i}`} hit={s} badge={i + 1} />
                ))}
              </>
            ) : null}
          </ScrollView>
        ) : (
          <FlatList
            style={styles.list}
            contentContainerStyle={styles.content}
            data={rows}
            keyExtractor={rowKey}
            renderItem={renderRow}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            ListEmptyComponent={
              query ? null : (
                <Text style={styles.notice}>
                  Search message history, channel names and topics, and groups.
                </Text>
              )
            }
          />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  list: { flex: 1 },
  content: { padding: 14, gap: 10, paddingBottom: 40 },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 14,
    marginTop: 10,
    backgroundColor: colors.panelStrong,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    paddingVertical: 9,
  },
  section: {
    color: colors.faint,
    fontSize: 11.5,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginTop: 6,
  },
  card: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    gap: 3,
  },
  cardTop: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  title: { color: colors.text, fontSize: 14.5, fontWeight: "700" },
  sub: { color: colors.dim, fontSize: 13 },
  hash: { color: colors.faint },
  crumbSuffix: { color: colors.faint, fontWeight: "400", fontSize: 12.5 },
  author: { color: colors.a1, fontSize: 13, fontWeight: "700", flex: 1 },
  ts: { color: colors.faint, fontSize: 11 },
  crumb: { color: colors.faint, fontSize: 12 },
  snippet: { color: colors.dim, fontSize: 13.5, lineHeight: 19 },
  snippetHit: { color: colors.a1, fontWeight: "700" },
  moreRow: { alignItems: "center", paddingVertical: 10 },
  moreText: { color: colors.a1, fontSize: 14, fontWeight: "700" },
  notice: { color: colors.dim, fontSize: 13.5, textAlign: "center", paddingVertical: 24 },
  askRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "rgba(139,124,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(139,124,255,0.45)",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  askRowText: { color: colors.text, fontSize: 14, fontWeight: "700", flex: 1 },
  askRowQuery: { color: colors.a1 },
  askCard: {
    backgroundColor: "rgba(139,124,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(139,124,255,0.45)",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  askHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  askTitle: { color: colors.text, fontSize: 14.5, fontWeight: "700", flex: 1 },
  askThinking: { flexDirection: "row", alignItems: "center", gap: 10 },
  askThinkingText: { color: colors.dim, fontSize: 13.5 },
  askAnswer: { color: colors.text, fontSize: 14.5, lineHeight: 21 },
  askError: { color: colors.red, fontSize: 13.5 },
  cite: { color: colors.a1, fontWeight: "700" },
  citeBadge: { color: colors.a1, fontSize: 12, fontWeight: "800" },
});
