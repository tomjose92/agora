/* The gesture regression these guard: on the iOS new architecture a parent
   Pressable steals the pan from a nested horizontal ScrollView
   (facebook/react-native#56879), so a bubble-wrapping Pressable made wide
   markdown tables unscrollable. MessageItem must keep the table's ScrollView
   free of Pressable ancestors while long-press-to-star stays reachable via
   the text blocks and the backdrop. */

// Ships untranspiled ESM; the icons are irrelevant to what these tests assert.
jest.mock("lucide-react-native", () => new Proxy({}, { get: () => () => null }));

import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ScrollView, StyleSheet } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MessageItem } from "../src/components/MessageItem";
import { useSession } from "../src/state/session";
import type { Message } from "../src/api/types";
import type { Session } from "../src/api/client";

const session: Session = { baseUrl: "http://test", token: "t" };

const TABLE =
  "intro text\n\n| Date | Item | Amount |\n|---|---|---|\n| 25 Jun | TST*ULA, San Francisco | USD 198.22 |";

function message(text: string): Message {
  return {
    id: 1,
    channel_id: "c1",
    thread_id: null,
    author_type: "user",
    author_id: "alice",
    author_name: "Alice",
    text,
    ts: 1_700_000_000,
    attachments: [],
  };
}

beforeAll(() => {
  // useSelectOption (rendered by every MessageItem) needs a signed-in ApiClient.
  useSession.setState({ status: "signedIn", session });
});

function render(m: Message, onLongPress?: (msg: Message) => void) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        React.createElement(MessageItem, { session, message: m, onLongPress }),
      ),
    );
  });
  return tree;
}

/* A Pressable renders as a host View wired with responder handlers; that's
   what steals the pan from the nested ScrollView, so that's what we assert
   against (the Pressable component itself is a memo/forwardRef wrapper that
   react-test-renderer doesn't expose as an instance). */
function claimsResponder(node: TestRenderer.ReactTestInstance): boolean {
  return typeof node.props?.onStartShouldSetResponder === "function";
}

function isBackdrop(node: TestRenderer.ReactTestInstance): boolean {
  return node.props?.style === StyleSheet.absoluteFill && claimsResponder(node);
}

test("the table's ScrollView has no pressable ancestor", () => {
  const tree = render(message(TABLE), () => {});
  const scroll = tree.root.findAllByType(ScrollView)[0];
  for (let node = scroll.parent; node; node = node.parent) {
    expect(claimsResponder(node)).toBe(false);
  }
});

test("long-press still reaches the handler from the text, and the backdrop exists", () => {
  const onLongPress = jest.fn();
  const m = message(TABLE);
  const tree = render(m, onLongPress);

  // Paragraph text carries the long-press directly…
  const texts = tree.root.findAll(
    (n: TestRenderer.ReactTestInstance) =>
      String(n.type) === "Text" && typeof n.props.onLongPress === "function",
  );
  expect(texts.length).toBeGreaterThan(0);
  texts[0].props.onLongPress();
  expect(onLongPress).toHaveBeenCalledWith(m);

  // …and the bubble keeps a backdrop Pressable for padding/gap presses.
  expect(tree.root.findAll(isBackdrop).length).toBeGreaterThan(0);
});

test("without an onLongPress handler no backdrop Pressable is rendered", () => {
  const tree = render(message(TABLE));
  expect(tree.root.findAll(isBackdrop)).toHaveLength(0);
});
