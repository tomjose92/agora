import { beforeEach, describe, expect, it } from "vitest";
import { useDrafts } from "../src";

describe("message drafts", () => {
  beforeEach(() => useDrafts.setState({ byConvo: {} }));

  it("isolates conversation text and removes empty entries", () => {
    useDrafts.getState().set("channel-a", "draft A ");
    useDrafts.getState().set("channel-b", "draft B");

    expect(useDrafts.getState().byConvo).toEqual({
      "channel-a": "draft A ",
      "channel-b": "draft B",
    });

    useDrafts.getState().set("channel-a", "");
    expect(useDrafts.getState().byConvo).toEqual({ "channel-b": "draft B" });
  });

  it("clears only the requested conversation", () => {
    useDrafts.setState({ byConvo: { "channel-a": "A", "channel-b": "B" } });
    useDrafts.getState().clear("channel-a");
    expect(useDrafts.getState().byConvo).toEqual({ "channel-b": "B" });
  });
});
