import { Redirect, useLocalSearchParams } from "expo-router";

export default function ChannelMessageDeepLink() {
  const { groupId, channelId, messageId } = useLocalSearchParams<{
    groupId: string;
    channelId: string;
    messageId: string;
  }>();
  return (
    <Redirect
      href={{
        pathname: "/(app)/channel/[id]",
        params: { id: channelId, groupId, messageId },
      }}
    />
  );
}
