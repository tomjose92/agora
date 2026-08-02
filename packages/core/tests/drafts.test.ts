import { beforeEach, describe, expect, it } from "vitest";
import { useMessageDrafts } from "../src";

describe("message drafts", () => {
  beforeEach(() => useMessageDrafts.setState({ byConvo: {} }));

  it("isolates conversation text and removes empty entries", () => {
    useMessageDrafts.getState().set("channel-a", "draft A ");
    useMessageDrafts.getState().set("channel-b", "draft B");

    expect(useMessageDrafts.getState().byConvo).toEqual({
      "channel-a": "draft A ",
      "channel-b": "draft B",
    });

    useMessageDrafts.getState().set("channel-a", "");
    expect(useMessageDrafts.getState().byConvo).toEqual({ "channel-b": "draft B" });
  });

  it("clears only the requested conversation", () => {
    useMessageDrafts.setState({ byConvo: { "channel-a": "A", "channel-b": "B" } });
    useMessageDrafts.getState().clear("channel-a");
    expect(useMessageDrafts.getState().byConvo).toEqual({ "channel-b": "B" });
  });

  it("resets every conversation", () => {
    useMessageDrafts.setState({ byConvo: { "channel-a": "A", "channel-b": "B" } });
    useMessageDrafts.getState().resetAll();
    expect(useMessageDrafts.getState().byConvo).toEqual({});
  });
});
