/* Attachment strip under a bubble: inline images and download chips. */

import { useState } from "react";
import type { Message } from "@agora/core";
import { fileUrl, humanSize, BROWSER_IMAGE, BROWSER_VIDEO } from "../lib/files";
import { Icon } from "../lib/icons";
import { ImageLightbox } from "./ImageLightbox";

export function Attachments({ message }: { message: Message }) {
  const [preview, setPreview] = useState<{ url: string; filename: string } | null>(null);
  const [failedVideos, setFailedVideos] = useState<Set<string>>(new Set());
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
        if (BROWSER_VIDEO.test(f.mime || "") && !failedVideos.has(f.id)) {
          return <video key={f.id} className="ago-att-video" src={url} controls preload="metadata"
            aria-label={`Play ${f.filename}`}
            onError={() => setFailedVideos(current => new Set(current).add(f.id))} />;
        }
        return (
          <a key={f.id} className="ago-att-file" href={url} download={f.filename}
            title={`Download ${f.filename}`}>
            <span className="ago-file-icon">
              <Icon name={(f.mime || "").startsWith("image/") ? "image" : "file-text"} />
            </span>
            <span className="ago-file-meta">
              <span className="fname">{f.filename}</span>
              <span className="fsize">{humanSize(f.size)}</span>
            </span>
          </a>
        );
      })}
      {preview && <ImageLightbox {...preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
