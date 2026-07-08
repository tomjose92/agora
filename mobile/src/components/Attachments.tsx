/* Message attachments: inline previews for images (fetched with the auth
   header), tap-to-download-and-share for everything else. */

import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
// The legacy API is the one with documented header support on downloads.
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { authHeaders, fileUrl, type Session } from "../api/client";
import type { Attachment } from "../api/types";
import { fmtSize } from "../lib/format";
import { colors } from "../lib/theme";
import { toastErr } from "./Toast";

async function downloadAndShare(session: Session, att: Attachment) {
  const target = `${FileSystem.cacheDirectory}${att.id}-${att.filename}`;
  const res = await FileSystem.downloadAsync(fileUrl(session, att.id), target, {
    headers: authHeaders(session),
  });
  if (res.status !== 200) throw new Error(`download failed (${res.status})`);
  await Sharing.shareAsync(res.uri, { mimeType: att.mime || undefined });
}

function FileChip({ session, att }: { session: Session; att: Attachment }) {
  const [busy, setBusy] = useState(false);
  return (
    <Pressable
      style={styles.chip}
      disabled={busy}
      onPress={async () => {
        setBusy(true);
        try {
          await downloadAndShare(session, att);
        } catch (e) {
          toastErr("Download failed", e);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <ActivityIndicator size="small" color={colors.dim} /> : <Text style={styles.icon}>📄</Text>}
      <View style={{ flexShrink: 1 }}>
        <Text style={styles.name} numberOfLines={1}>
          {att.filename}
        </Text>
        <Text style={styles.size}>{fmtSize(att.size)}</Text>
      </View>
    </Pressable>
  );
}

export function Attachments({
  session,
  attachments,
}: {
  session: Session;
  attachments: Attachment[];
}) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <View style={styles.wrap}>
      {attachments.map((att) =>
        att.mime.startsWith("image/") ? (
          <Image
            key={att.id}
            source={{ uri: fileUrl(session, att.id), headers: authHeaders(session) }}
            style={styles.image}
            contentFit="cover"
            transition={100}
          />
        ) : (
          <FileChip key={att.id} session={session} att={att} />
        ),
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, marginTop: 6 },
  image: {
    width: 220,
    height: 160,
    borderRadius: 10,
    backgroundColor: colors.panelStrong,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    alignSelf: "flex-start",
    backgroundColor: colors.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    maxWidth: 260,
  },
  icon: { fontSize: 16 },
  name: { color: colors.text, fontSize: 13, fontWeight: "600" },
  size: { color: colors.dim, fontSize: 11.5 },
});
