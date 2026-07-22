/* Port of the retired vanilla shim.js autoGrow(): size a textarea to its content. */
export function autoGrow(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
}
