/* Interactive forms (meta.form). Shared state:
   meta.form_state holds the live values every member sees; checkbox taps
   persist immediately, typed text stays a local draft until its check icon
   (or Enter) confirms it. A button press submits and locks the form. */

import { useState } from "react";
import { useSubmitForm, useUpdateFormState, fmtTs, type Message } from "@agora/core";
import { Icon } from "../lib/icons";
import { toast } from "../lib/toast";

export function MessageFormView({ message }: { message: Message }) {
  const update = useUpdateFormState();
  const submit = useSubmitForm();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const meta = message.meta;
  const form = meta?.form && typeof meta.form === "object" ? meta.form : null;
  if (!form || !Array.isArray(form.fields) || !Array.isArray(form.buttons)) return null;
  const state = meta?.form_state && typeof meta.form_state === "object" ? meta.form_state : {};
  const done = meta?.form_submitted && typeof meta.form_submitted === "object"
    ? meta.form_submitted : null;

  if (done) {
    const values = done.values && typeof done.values === "object" ? done.values : {};
    const btn = form.buttons.find(b => b.id === done.button_id);
    return (
      <div className="ago-form submitted">
        {form.fields.map(f => {
          const v = values[f.id];
          return (
            <div key={f.id} className="ago-form-row done">
              <span className="lbl">{f.label}</span>
              <span className="val">
                {f.kind === "checkbox" ? (v ? <Icon name="check" /> : "—") : (v ? String(v) : "—")}
              </span>
            </div>
          );
        })}
        <div className="ago-form-done">
          <span className="what"><Icon name="check" /><span>{btn?.label || done.button_id || "Submitted"}</span></span>
          <span className="dim">by {done.by || "?"}{done.ts ? ` · ${fmtTs(done.ts)}` : ""}</span>
        </div>
      </div>
    );
  }

  const confirmField = (fieldId: string) => {
    const draft = drafts[fieldId];
    if (draft === undefined) return;
    update.mutate({ messageId: message.id, fieldId, value: draft }, {
      onSuccess: () => setDrafts(d => { const n = { ...d }; delete n[fieldId]; return n; }),
      onError: (e) => toast("Couldn't save: " + (e as Error).message, { variant: "warn" }),
    });
  };

  return (
    <div className="ago-form">
      {form.fields.map(f => {
        if (f.kind === "checkbox") {
          const on = state[f.id] === true;
          return (
            <button key={f.id} className={`ago-form-check ${on ? "on" : ""}`}
              onClick={() => update.mutate({ messageId: message.id, fieldId: f.id, value: !on })}>
              <span className="box">{on ? <Icon name="check" /> : null}</span>
              <span className="lbl">{f.label}</span>
            </button>
          );
        }
        const server = typeof state[f.id] === "string" ? (state[f.id] as string) : "";
        const draft = drafts[f.id];
        const dirty = draft !== undefined && draft !== server;
        return (
          <div key={f.id} className="ago-form-field">
            <label className="lbl">{f.label}</label>
            <span className="ago-form-inwrap">
              <input className="ago-form-input" type="text" maxLength={2000}
                data-mid={message.id} data-fid={f.id}
                placeholder={f.placeholder || ""}
                value={dirty || draft !== undefined ? draft : server}
                onChange={e => setDrafts(d => ({ ...d, [f.id]: e.target.value }))}
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); confirmField(f.id); } }} />
              <button className={`ago-form-confirm ${dirty ? "dirty" : ""}`}
                title="Save this value for everyone" onClick={() => confirmField(f.id)}>
                <Icon name="check" />
              </button>
            </span>
          </div>
        );
      })}
      <div className="ago-form-actions">
        {form.buttons.map(b => (
          <button key={b.id}
            className={`ago-option-btn ${b.style === "primary" ? "primary" : "secondary"}`}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              submit.mutate({ messageId: message.id, buttonId: b.id }, {
                onSettled: () => setBusy(false),
                onError: (e) => toast("Submit failed: " + (e as Error).message, { variant: "warn" }),
              });
            }}>
            {b.label || b.id}
          </button>
        ))}
      </div>
    </div>
  );
}
