import { conversationSections } from "@agora/core";
import {
  fixtureAgentMessage,
  fixtureRootMessage,
} from "@agora/core/testing/fixtures";
import {
  activeSectionIndex,
  messageRowIndex,
  visibleSectionWindow,
} from "../src/components/SectionRail";

describe("conversation sections", () => {
  it("handles an empty timeline", () => {
    expect(conversationSections([])).toEqual([]);
  });

  it("starts at the first message and at each user turn", () => {
    const messages = [
      fixtureRootMessage,
      fixtureAgentMessage,
      { ...fixtureRootMessage, id: 50, text: "  Second\n  question  " },
      { ...fixtureAgentMessage, id: 51 },
    ];
    expect(
      conversationSections(messages).map((section) => section.mid),
    ).toEqual([fixtureRootMessage.id, 50]);
    expect(conversationSections(messages)[1].label).toContain(
      "Second question",
    );
  });

  it("keeps a leading agent group as its own section", () => {
    expect(
      conversationSections([
        fixtureAgentMessage,
        { ...fixtureRootMessage, id: 50 },
      ]),
    ).toHaveLength(2);
  });

  it("maps the active message after rows are prepended", () => {
    const sections = conversationSections([
      { ...fixtureRootMessage, id: 10 },
      { ...fixtureRootMessage, id: 20 },
      { ...fixtureRootMessage, id: 30 },
    ]);
    expect(activeSectionIndex(sections, 25)).toBe(1);
    const prepended = conversationSections([
      { ...fixtureRootMessage, id: 5 },
      ...[
        { ...fixtureRootMessage, id: 10 },
        { ...fixtureRootMessage, id: 20 },
        { ...fixtureRootMessage, id: 30 },
      ],
    ]);
    expect(activeSectionIndex(prepended, 25)).toBe(2);
  });

  it("resolves the current index after a divider and older-page prepend", () => {
    const target = { kind: "msg", m: { id: 30 } };
    expect(messageRowIndex([{ kind: "divider" }, target], 30)).toBe(1);
    expect(
      messageRowIndex(
        [{ kind: "msg", m: { id: 10 } }, { kind: "divider" }, target],
        30,
      ),
    ).toBe(2);
  });

  it("windows many thread turns around the active section", () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    expect(visibleSectionWindow(items, 15)).toEqual(items.slice(9, 21));
    expect(visibleSectionWindow(items, 0)).toEqual(items.slice(0, 12));
    expect(visibleSectionWindow(items, items.length - 1)).toEqual(items.slice(18));
  });

  it("defaults active selection to the first section", () => {
    const sections = conversationSections([
      fixtureRootMessage,
      { ...fixtureRootMessage, id: 50 },
    ]);
    expect(activeSectionIndex(sections, null)).toBe(0);
  });

  it("uses the author fallback for blank text and ellipsizes long labels", () => {
    const blank = conversationSections([{ ...fixtureRootMessage, text: " \n " }])[0];
    const long = conversationSections([{ ...fixtureRootMessage, text: "x".repeat(80) }])[0];
    expect(blank.label).toBe(fixtureRootMessage.author_name || fixtureRootMessage.author_id);
    expect(long.label.endsWith("…")).toBe(true);
  });
});
