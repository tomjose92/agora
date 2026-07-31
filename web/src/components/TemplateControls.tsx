/* Message templates: the picker is a composer-anchored popover (like "Talk
   to"), and create/edit/delete live in a separate dialog so choosing a
   template stays a one-click path. Templates are private per user + group. */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  MAX_MESSAGE_CHARS,
  useCreateTemplate,
  useDeleteTemplate,
  useTemplates,
  useUpdateTemplate,
  type MessageTemplate,
} from "@agora/core";
import { Icon } from "../lib/icons";
import { watchAnchoredOverlay } from "../lib/anchoredOverlay";
import { toast } from "../lib/toast";
import { confirmStep, useConfirm } from "../state/confirm";

export function TemplateControls({ groupId, draft, onChoose }: {
  groupId: string;
  /** Current draft — prefills a new template ("save what I just typed"). */
  draft: string;
  onChoose: (text: string) => void;
}) {
  const list = useTemplates(groupId);
  const createTemplate = useCreateTemplate(groupId);
  const updateTemplate = useUpdateTemplate(groupId);
  const deleteTemplate = useDeleteTemplate(groupId);
  const [open, setOpen] = useState(false);
  const [manage, setManage] = useState(false);
  /* "new" = the editor is open on an unsaved template. */
  const [editing, setEditing] = useState<MessageTemplate | "new" | null>(null);
  const [label, setLabel] = useState("");
  const [body, setBody] = useState("");
  const armed = useConfirm(s => s.armed);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /* Keep the popover glued to its button through resizes and pane scrolling
     (same helper the reaction popovers use). */
  useLayoutEffect(() => {
    if (!open || !btnRef.current || !popRef.current) return;
    return watchAnchoredOverlay(btnRef.current, popRef.current, "center");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".ago-template-pop") && !target.closest(".ago-template-btn")) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  /* Escape unwinds one layer at a time: editor → dialog → picker. */
  useEffect(() => {
    if (!open && !manage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (editing) setEditing(null);
      else if (manage) setManage(false);
      else setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, manage, editing]);

  /* The dialog claims aria-modal, so move focus into it and restore the
     invoking control when it closes. A shared focus trap is a later refactor. */
  useEffect(() => {
    if (!manage) return;
    requestAnimationFrame(() => panelRef.current?.focus());
    return () => btnRef.current?.focus();
  }, [manage]);

  const edit = (target: MessageTemplate | "new") => {
    setEditing(target);
    setLabel(target === "new" ? "" : target.label);
    setBody(target === "new" ? draft : target.text);
  };

  const save = async () => {
    try {
      if (editing === "new") await createTemplate.mutateAsync({ label, text: body });
      else if (editing) await updateTemplate.mutateAsync({ id: editing.id, label, text: body });
      setEditing(null);
    } catch (e) {
      toast(`Could not save template: ${(e as Error).message}`, { variant: "warn" });
    }
  };

  const remove = (template: MessageTemplate) => {
    if (!confirmStep(`tpl:${template.id}`)) return;
    deleteTemplate.mutateAsync(template.id).catch(e =>
      toast(`Could not delete template: ${(e as Error).message}`, { variant: "warn" }));
  };

  const openManager = (target?: "new") => {
    setOpen(false);
    setManage(true);
    if (target) edit(target);
  };

  const templates = list.data || [];
  const armKey = (id: string) => `tpl:${id}`;

  /* Shared by the picker and the manage list: one fetch, three states. */
  const listState = (rows: () => React.ReactNode) => list.isLoading
    ? <div className="ago-template-state">Loading…</div>
    : list.isError
      ? (
        <div className="ago-template-state error">
          Couldn’t load templates.{" "}
          <button onClick={() => void list.refetch()}>Try again</button>
        </div>
      )
      : templates.length
        ? rows()
        : <div className="ago-template-state">No templates yet.</div>;

  return (
    <>
      <button ref={btnRef} className={`btn ago-template-btn ${open ? "active" : ""}`}
        title="Message templates" aria-expanded={open} aria-controls="ago-template-pop"
        onClick={() => setOpen(!open)}>
        <Icon name="file-text" />
      </button>
      {open && (
        <div ref={popRef} className="ago-template-pop" id="ago-template-pop">
          <div className="ago-template-head">
            <strong>Templates</strong>
            <button onClick={() => openManager()}>Manage</button>
          </div>
          {listState(() => templates.map(t => (
            <button key={t.id} className="ago-template-opt"
              onClick={() => { onChoose(t.text); setOpen(false); }}>
              <strong>{t.label}</strong>
              <span>{t.text}</span>
            </button>
          )))}
          <button className="ago-template-add" onClick={() => openManager("new")}>
            + Add template
          </button>
        </div>
      )}
      {manage && (
        <div className="conn-overlay"
          onMouseDown={e => {
            if (e.target !== e.currentTarget) return;
            setManage(false);
            setEditing(null);
          }}>
          <div ref={panelRef} className="conn-panel ago-template-dialog" role="dialog"
            aria-modal="true" aria-label="Message templates" tabIndex={-1}>
            <div className="ago-template-head">
              <strong>
                {editing
                  ? (editing === "new" ? "New template" : "Edit template")
                  : "Manage templates"}
              </strong>
              <button className="btn" aria-label="Close"
                onClick={() => editing ? setEditing(null) : setManage(false)}>
                <Icon name="x" />
              </button>
            </div>
            {editing ? (
              <>
                <label>Label
                  <input value={label} maxLength={80} placeholder="Optional label"
                    onChange={e => setLabel(e.target.value)} />
                </label>
                <label>Message
                  <textarea value={body} maxLength={MAX_MESSAGE_CHARS} rows={7}
                    onChange={e => setBody(e.target.value)} />
                </label>
                <div className="ago-template-actions">
                  <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
                  <button className="btn primary"
                    disabled={!body.trim() || createTemplate.isPending || updateTemplate.isPending}
                    onClick={() => void save()}>Save</button>
                </div>
              </>
            ) : (
              <>
                <button className="ago-template-add" onClick={() => edit("new")}>
                  + New template
                </button>
                {listState(() => templates.map(t => (
                  <div key={t.id} className="ago-template-manage-row">
                    <div>
                      <strong>{t.label}</strong>
                      <span>{t.text}</span>
                    </div>
                    <button className="btn sm" onClick={() => edit(t)}>Edit</button>
                    <button className={`btn sm danger ${armed === armKey(t.id) ? "armed" : ""}`}
                      title={armed === armKey(t.id)
                        ? "Click again to delete this template"
                        : "Delete this template"}
                      onClick={() => remove(t)}>
                      {armed === armKey(t.id) ? "Sure?" : "Delete"}
                    </button>
                  </div>
                )))}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
