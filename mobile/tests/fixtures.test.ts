import {
  fixtureAgentMessage,
  fixtureGroups,
  fixtureMe,
} from "@agora/core/testing/fixtures";

describe("shared UI fixtures", () => {
  it("preserves the relationships used by connected component stories", () => {
    expect(
      fixtureGroups.some((group) =>
        group.channels.some(
          (channel) => channel.id === fixtureAgentMessage.channel_id,
        ),
      ),
    ).toBe(true);
    expect(
      fixtureAgentMessage.reactions?.find(
        (reaction) => reaction.emoji === "👍",
      )?.users,
    ).toContain(fixtureMe.username);
  });
});
