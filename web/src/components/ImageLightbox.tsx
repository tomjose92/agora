import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../lib/icons";

export function ImageLightbox({
  url,
  filename,
  onClose,
}: {
  url: string;
  filename: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
      if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return createPortal((
    <div
      className="ago-image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`Image preview: ${filename}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="ago-image-lightbox-inner">
        <button
          ref={closeRef}
          type="button"
          className="ago-image-lightbox-close"
          aria-label="Close image preview"
          onClick={onClose}
        >
          <Icon name="x" />
        </button>
        <img src={url} alt={filename} />
        <div className="ago-image-lightbox-name">{filename}</div>
      </div>
    </div>
  ), document.body);
}
