/* Themed wrapper around lucide-react-native, matching the web UI's icon
   style (ui/icons.js): stroke 1.8, round caps, dim by default. Pass the
   Lucide component itself so the bundle only carries the icons we use:
   <Icon icon={Mic} size={20} color={colors.text} /> */

import React from "react";
import type { LucideIcon } from "lucide-react-native";
import { colors } from "../lib/theme";

export function Icon({
  icon: Glyph,
  size = 18,
  color = colors.dim,
  fill = "none",
  strokeWidth = 1.8,
}: {
  icon: LucideIcon;
  size?: number;
  color?: string;
  /** "currentColor"-style solid fill for active pin/star states. */
  fill?: string;
  strokeWidth?: number;
}) {
  return <Glyph size={size} color={color} fill={fill} strokeWidth={strokeWidth} />;
}
