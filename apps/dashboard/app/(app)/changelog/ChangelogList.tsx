"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm";
import { createChangelogEntry, updateChangelogEntry, publishEntry, deleteChangelogEntry } from "./actions";

export type ChangelogRow = {
  id: string;
  title: string;
  body: string;
  isPublic: boolean;
  publishedAt: string | null;
};

export function ChangelogList({ entries, canManage }: { entries: ChangelogRow[]; canManage: boolean }) {
  const drafts = entries.filter((e) => !e.publishedAt);
  const published = entries.filter((e) => e.publishedAt);

  return (
    <div className="col gap-4">
      {canManage && <NewEntry />}

      {drafts.length > 0 && (
        <section className="col gap-2">
          <h2 className="eyebrow">Drafts</h2>
          {drafts.map((e) => (
            <EntryCard key={e.id} entry={e} canManage={canManage} />
          ))}
        </section>
      )}

      <section className="col gap-2">
        <h2 className="eyebrow">Published</h2>
        {published.length === 0 ? (
          <div className="card">
            <div className="card-body">
              <p className="text-sm muted" style={{ margin: 0 }}>
                Nothing published yet. Ship an initiative and a draft lands here ready to announce.
              </p>
            </div>
          </div>
        ) : (
          published.map((e) => <EntryCard key={e.id} entry={e} canManage={canManage} />)
        )}
      </section>
    </div>
  );
}

function NewEntry() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <button type="button" className="btn sm" onClick={() => setOpen(true)}>
        + New entry
      </button>
    );
  }
  return (
    <div className="card">
      <div className="card-body col gap-3">
        <label className="col gap-1">
          <span className="eyebrow">Title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} disabled={pending} placeholder="What shipped" />
        </label>
        <label className="col gap-1">
          <span className="eyebrow">Body</span>
          <textarea className="input" rows={4} value={body} onChange={(e) => setBody(e.target.value)} disabled={pending} placeholder="A short note your customers will read." />
        </label>
        <div className="row gap-2">
          <button
            type="button"
            className="btn sm"
            disabled={pending || !title.trim()}
            onClick={() =>
              start(async () => {
                const r = await createChangelogEntry({ title, body });
                if (r.ok) {
                  toast.show({ message: "Draft created." });
                  setTitle("");
                  setBody("");
                  setOpen(false);
                } else {
                  toast.show({ message: `Couldn't create draft (${r.error}).` });
                }
              })
            }
          >
            Save draft
          </button>
          <button type="button" className="btn sm ghost" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function EntryCard({ entry, canManage }: { entry: ChangelogRow; canManage: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(entry.title);
  const [body, setBody] = useState(entry.body);
  const [pending, start] = useTransition();
  const isPublished = !!entry.publishedAt;

  return (
    <div className="card">
      <div className="card-body col gap-3">
        <div className="row between center" style={{ flexWrap: "wrap", gap: 8 }}>
          <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
            <span className="text-sm fw-med">{entry.title}</span>
            <span className="text-xs muted">{isPublished ? new Date(entry.publishedAt!).toLocaleDateString() : "Draft"}</span>
            {!entry.isPublic && <span className="text-xs muted">· internal</span>}
          </div>
          {canManage && (
            <div className="row gap-2 center">
              {!isPublished && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const r = await publishEntry(entry.id);
                      toast.show({ message: r.ok ? "Published and announced." : `Couldn't publish (${r.error}).` });
                    })
                  }
                >
                  Publish &amp; announce
                </button>
              )}
              <button type="button" className="btn sm ghost" disabled={pending} onClick={() => setEditing((v) => !v)}>
                {editing ? "Close" : "Edit"}
              </button>
              <button
                type="button"
                className="btn sm ghost"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    if (!(await confirm({ title: "Delete this entry?", confirmLabel: "Delete" }))) return;
                    const r = await deleteChangelogEntry(entry.id);
                    toast.show({ message: r.ok ? "Deleted." : `Couldn't delete (${r.error}).` });
                  })
                }
              >
                Delete
              </button>
            </div>
          )}
        </div>

        {editing ? (
          <div className="col gap-3">
            <label className="col gap-1">
              <span className="eyebrow">Title</span>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} disabled={pending} />
            </label>
            <label className="col gap-1">
              <span className="eyebrow">Body</span>
              <textarea className="input" rows={4} value={body} onChange={(e) => setBody(e.target.value)} disabled={pending} />
            </label>
            <div className="row gap-2">
              <button
                type="button"
                className="btn sm"
                disabled={pending || !title.trim()}
                onClick={() =>
                  start(async () => {
                    const r = await updateChangelogEntry(entry.id, { title, body });
                    if (r.ok) {
                      toast.show({ message: "Saved." });
                      setEditing(false);
                    } else {
                      toast.show({ message: `Couldn't save (${r.error}).` });
                    }
                  })
                }
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          entry.body && (
            <p className="text-sm muted" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
              {entry.body}
            </p>
          )
        )}
      </div>
    </div>
  );
}
