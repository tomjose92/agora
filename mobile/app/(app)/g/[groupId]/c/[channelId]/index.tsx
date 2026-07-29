import { Redirect, useLocalSearchParams } from "expo-router";

export default function ChannelDeepLink() {
  const { groupId, channelId } = useLocalSearchParams<{
    groupId: string;
    channelId: string;
  }>();
  return (
    <Redirect
      href={{
        pathname: "/(app)/channel/[id]",
        params: { id: channelId, groupId },
      }}
    />
  );
}
