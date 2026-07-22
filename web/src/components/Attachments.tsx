/* Attachment strip under a bubble: inline images and download chips. */

import type { Message } from "@agora/core";
import { fileUrl, humanSize, BROWSER_IMAGE } from "../lib/files";
import { Icon } from "../lib/icons";

export function Attachments({ message }: { message: Message }) {
  const files = message.attachments || [];
  if (!files.length) return null;
  return (
    <div className="ago-atts">
      {files.map(f => {
        const url = fileUrl(f.id);
        if (BROWSER_IMAGE.test(f.mime || "")) {
          return (
            <a key={f.id} className="ago-att-img" href={url} target="_blank" rel="noopener noreferrer">
              <img src={url} alt={f.filename} loading="lazy" />
            </a>
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
    </div>
  );
}
