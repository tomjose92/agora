import { Redirect, useLocalSearchParams } from "expo-router";

export default function GroupDeepLink() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  return <Redirect href={{ pathname: "/(app)", params: { groupId } }} />;
}
