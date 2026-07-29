import { Redirect, useLocalSearchParams } from "expo-router";

export default function ThreadMessageDeepLink() {
  const { groupId, channelId, threadId, messageId } = useLocalSearchParams<{
    groupId: string;
    channelId: string;
    threadId: string;
    messageId: string;
  }>();
  return (
    <Redirect
      href={{
        pathname: "/(app)/thread/[channelId]/[rootId]",
        params: { channelId, rootId: threadId, messageId, groupId },
      }}
    />
  );
}
