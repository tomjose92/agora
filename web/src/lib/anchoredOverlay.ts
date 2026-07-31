export type OverlayAlignment = "start" | "center";

/** Position a fixed overlay beside its anchor and keep it attached through
    viewport resizes and scrolling in any nested pane. */
export function watchAnchoredOverlay(
  anchor: HTMLElement,
  overlay: HTMLElement,
  alignment: OverlayAlignment,
): () => void {
  let frame = 0;
  const place = () => {
    frame = 0;
    overlay.style.maxHeight = "";
    const rect = anchor.getBoundingClientRect();
    const gutter = 8;
    const gap = 6;
    const naturalHeight = overlay.offsetHeight;
    const aboveSpace = rect.top - gap - gutter;
    const belowSpace = window.innerHeight - rect.bottom - gap - gutter;
    const above = naturalHeight <= aboveSpace || aboveSpace >= belowSpace;
    const available = Math.max(80, above ? aboveSpace : belowSpace);
    overlay.style.maxHeight = `${Math.min(naturalHeight, available)}px`;

    const width = overlay.offsetWidth;
    const wantedLeft = alignment === "center"
      ? rect.left + rect.width / 2 - width / 2
      : rect.left;
    const left = Math.max(gutter, Math.min(wantedLeft, window.innerWidth - width - gutter));
    const height = Math.min(naturalHeight, available);
    const top = above ? rect.top - height - gap : rect.bottom + gap;
    overlay.style.left = `${left}px`;
    overlay.style.top = `${Math.max(gutter, top)}px`;
    overlay.dataset.placement = above ? "above" : "below";
    const arrow = Math.max(12, Math.min(rect.left + rect.width / 2 - left, width - 12));
    overlay.style.setProperty("--ago-anchor-x", `${arrow}px`);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(place);
  };
  place();
  window.addEventListener("resize", schedule);
  document.addEventListener("scroll", schedule, { capture: true, passive: true });
  return () => {
    if (frame) cancelAnimationFrame(frame);
    window.removeEventListener("resize", schedule);
    document.removeEventListener("scroll", schedule, true);
  };
}
