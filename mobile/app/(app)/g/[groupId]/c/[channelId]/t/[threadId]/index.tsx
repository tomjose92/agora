import { Redirect, useLocalSearchParams } from "expo-router";

export default function ThreadDeepLink() {
  const { groupId, channelId, threadId } = useLocalSearchParams<{
    groupId: string;
    channelId: string;
    threadId: string;
  }>();
  return (
    <Redirect
      href={{
        pathname: "/(app)/thread/[channelId]/[rootId]",
        params: { channelId, rootId: threadId, groupId },
      }}
    />
  );
}
