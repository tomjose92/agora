export type OverlayAlignment = "start" | "center";

/** Position a fixed overlay beside its anchor and keep it attached through
    viewport resizes and scrolling in any nested pane. */
export function watchAnchoredOverlay(
  anchor: HTMLElement,
  overlay: HTMLElement,
  alignment: OverlayAlignment,
): () => void {
  let frame = 0;
  let releaseResizeGuard = 0;
  let ignoreOverlayResize = false;
  const place = () => {
    frame = 0;
    ignoreOverlayResize = true;
    overlay.style.maxHeight = "";
    const rect = anchor.getBoundingClientRect();
    const offscreen = rect.bottom < 0 || rect.top > window.innerHeight;
    overlay.style.visibility = offscreen ? "hidden" : "";
    if (offscreen) {
      if (releaseResizeGuard) cancelAnimationFrame(releaseResizeGuard);
      releaseResizeGuard = requestAnimationFrame(() => { ignoreOverlayResize = false; });
      return;
    }
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
    const height = Math.min(naturalHeight, available, window.innerHeight - gutter * 2);
    const wanted = above ? rect.top - height - gap : rect.bottom + gap;
    const top = Math.min(
      Math.max(gutter, wanted),
      Math.max(gutter, window.innerHeight - height - gutter),
    );
    overlay.style.left = `${left}px`;
    overlay.style.top = `${top}px`;
    overlay.dataset.placement = above ? "above" : "below";
    const arrow = Math.max(12, Math.min(rect.left + rect.width / 2 - left, width - 12));
    overlay.style.setProperty("--ago-anchor-x", `${arrow}px`);
    if (releaseResizeGuard) cancelAnimationFrame(releaseResizeGuard);
    releaseResizeGuard = requestAnimationFrame(() => { ignoreOverlayResize = false; });
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(place);
  };
  const observer = new ResizeObserver((entries) => {
    if (ignoreOverlayResize && entries.every(entry => entry.target === overlay)) return;
    schedule();
  });
  observer.observe(anchor);
  observer.observe(overlay);
  observer.observe(document.documentElement);
  place();
  window.addEventListener("resize", schedule);
  document.addEventListener("scroll", schedule, { capture: true, passive: true });
  return () => {
    if (frame) cancelAnimationFrame(frame);
    if (releaseResizeGuard) cancelAnimationFrame(releaseResizeGuard);
    observer.disconnect();
    window.removeEventListener("resize", schedule);
    document.removeEventListener("scroll", schedule, true);
  };
}
