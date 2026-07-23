/* Attachment strip under a bubble — same markup as agoAttachmentsHTML. */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Message } from "@agora/core";
import { fileUrl, humanSize, BROWSER_IMAGE } from "../lib/files";
import { Icon } from "../lib/icons";

export function Attachments({ message }: { message: Message }) {
  const [preview, setPreview] = useState<{ url: string; filename: string } | null>(null);
  useEffect(() => {
    if (!preview) return;
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") setPreview(null); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [preview]);
  const files = message.attachments || [];
  if (!files.length) return null;
  return (
    <div className="ago-atts">
      {files.map(f => {
        const url = fileUrl(f.id);
        if (BROWSER_IMAGE.test(f.mime || "")) {
          return (
            <button key={f.id} type="button" className="ago-att-img"
              aria-label={`Preview ${f.filename}`}
              onClick={() => setPreview({ url, filename: f.filename })}>
              <img src={url} alt={f.filename} loading="lazy" />
            </button>
          );
        }
        return (
          <a key={f.id} className="ago-att-file" href={url} download={f.filename}
            title={`Download ${f.filename}`}>
            <Icon name={(f.mime || "").startsWith("image/") ? "image" : "file-text"} />
            {" "}<span className="fname">{f.filename}</span>{" "}
            <span className="fsize">{humanSize(f.size)}</span>
          </a>
        );
      })}
      {preview && createPortal((
        <div className="ago-image-lightbox" role="dialog" aria-modal="true"
          aria-label={`Image preview: ${preview.filename}`}
          onClick={e => { if (e.target === e.currentTarget) setPreview(null); }}>
          <div className="ago-image-lightbox-inner">
            <button type="button" className="ago-image-lightbox-close"
              aria-label="Close image preview" onClick={() => setPreview(null)}>
              <Icon name="x" />
            </button>
            <img src={preview.url} alt={preview.filename} />
            <div className="ago-image-lightbox-name">{preview.filename}</div>
          </div>
        </div>
      ), document.body)}
    </div>
  );
}
