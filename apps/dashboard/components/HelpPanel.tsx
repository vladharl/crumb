"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import Link from "next/link";
import { Btn, Field, Ic } from "@crumb/ui";
import { useToast } from "@/components/toast";
import { HELP_GROUPS, DOCS_URL } from "@/lib/help-content";
import { submitSupportRequest } from "@/app/(app)/help-actions";

type View = "faq" | "contact";

const Ctx = createContext<{ open: () => void } | null>(null);

export function useHelp() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useHelp must be used within <HelpProvider>");
  return c;
}

/**
 * In-app Help & Support — a right-anchored slide-over opened from the top-bar "?"
 * button (or the avatar / mobile menus). Two views: a searchable FAQ and, when the
 * deployment has a support address wired, a Contact form that emails it. Open/close
 * + Escape mirror the ⌘K palette idiom in CommandPalette.tsx.
 */
export function HelpProvider({
  supportEnabled,
  userEmail,
  children,
}: {
  supportEnabled: boolean;
  userEmail: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("faq");
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const openPanel = useCallback(() => { setView("faq"); setQ(""); setOpen(true); }, []);
  const close = useCallback(() => setOpen(false), []);

  // Escape closes from anywhere while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus the search field when the FAQ view appears.
  useEffect(() => {
    if (open && view === "faq") searchRef.current?.focus();
  }, [open, view]);

  const searching = q.trim().length > 0;
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return HELP_GROUPS;
    return HELP_GROUPS
      .map(g => ({ ...g, items: g.items.filter(it => `${it.q} ${it.a} ${it.keywords ?? ""}`.toLowerCase().includes(s)) }))
      .filter(g => g.items.length > 0);
  }, [q]);

  return (
    <Ctx.Provider value={{ open: openPanel }}>
      {children}
      <div className={`help-scrim ${open ? "show" : ""}`} onClick={close} aria-hidden={!open} />
      <aside
        className={`help-panel ${open ? "open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Help and support"
        aria-hidden={!open}
      >
        <div className="help-head">
          <span className="help-title">{view === "contact" ? "Contact support" : "Help"}</span>
          <button type="button" className="help-close" aria-label="Close help" onClick={close}>
            <Ic.x style={{ width: 15, height: 15 }} />
          </button>
        </div>

        {view === "faq" ? (
          <div className="help-body">
            <div className="help-search">
              <Ic.search style={{ width: 15, height: 15, color: "var(--mute-2)", flexShrink: 0 }} />
              <input
                ref={searchRef}
                className="help-search-input"
                placeholder="Search help…"
                value={q}
                onChange={e => setQ(e.target.value)}
              />
            </div>

            {filtered.length === 0 && (
              <p className="help-empty">No help articles match “{q.trim()}”. Try different words, or contact us below.</p>
            )}

            {filtered.map(g => (
              <div key={g.group} className="help-group">
                <span className="eyebrow help-group-label">{g.group}</span>
                {g.items.map(it =>
                  searching ? (
                    <div key={it.q} className="help-faq-item open">
                      <div className="help-q-static">{it.q}</div>
                      <Answer item={it} onNavigate={close} />
                    </div>
                  ) : (
                    <details key={it.q} className="help-faq-item">
                      <summary className="help-q">
                        <Ic.chevR className="help-chev" style={{ width: 13, height: 13 }} />
                        <span>{it.q}</span>
                      </summary>
                      <Answer item={it} onNavigate={close} />
                    </details>
                  ),
                )}
              </div>
            ))}

            <div className="help-foot">
              <span className="help-foot-title">Still need help?</span>
              <div className="row gap-2" style={{ flexWrap: "wrap" }}>
                {supportEnabled && (
                  <Btn variant="primary" sm onClick={() => setView("contact")}>
                    Contact support
                  </Btn>
                )}
                <a className="help-docs-link" href={DOCS_URL} target="_blank" rel="noopener noreferrer">
                  <Ic.doc style={{ width: 13, height: 13 }} />
                  Documentation ↗
                </a>
              </div>
            </div>
          </div>
        ) : (
          <ContactForm
            userEmail={userEmail}
            onDone={() => { setView("faq"); }}
            onBack={() => setView("faq")}
          />
        )}
      </aside>
    </Ctx.Provider>
  );
}

function Answer({ item, onNavigate }: { item: (typeof HELP_GROUPS)[number]["items"][number]; onNavigate: () => void }) {
  return (
    <div className="help-a">
      <p>{item.a}</p>
      {item.link && (
        <Link href={item.link.href} className="help-a-link" onClick={onNavigate}>
          {item.link.label} →
        </Link>
      )}
    </div>
  );
}

function ContactForm({
  userEmail,
  onDone,
  onBack,
}: {
  userEmail: string;
  onDone: () => void;
  onBack: () => void;
}) {
  const { show } = useToast();
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const subjectRef = useRef<HTMLInputElement>(null);

  useEffect(() => { subjectRef.current?.focus(); }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await submitSupportRequest({ subject, message });
      if (!res.ok) {
        setError(res.error);
        show({ message: res.error, tone: "error" });
        return;
      }
      show({ message: "Message sent — we'll reply by email." });
      setSubject("");
      setMessage("");
      onDone();
    });
  }

  return (
    <form className="help-body help-contact" onSubmit={submit}>
      <button type="button" className="help-back" onClick={onBack}>
        ← Back to help
      </button>

      <p className="help-contact-lede">
        Send us a message and we'll reply to <span className="mono">{userEmail}</span>.
      </p>

      <Field label="Subject">
        <input
          ref={subjectRef}
          className="input"
          placeholder="What do you need help with?"
          value={subject}
          maxLength={160}
          onChange={e => setSubject(e.target.value)}
          disabled={pending}
          required
        />
      </Field>

      <Field label="Message">
        <textarea
          className="input"
          placeholder="Describe what's happening, with any steps to reproduce."
          value={message}
          maxLength={5000}
          rows={6}
          onChange={e => setMessage(e.target.value)}
          disabled={pending}
          required
        />
      </Field>

      {error && (
        <div className="text-sm" style={{
          background: "var(--err-bg)",
          border: "1px solid var(--err-border)",
          color: "var(--err-text)",
          borderRadius: "var(--r-sm)",
          padding: "10px 12px",
        }}>{error}</div>
      )}

      <Btn
        variant="primary"
        full
        type="submit"
        icon={<Ic.send style={{ width: 12, height: 12 }} />}
        disabled={pending || !subject.trim() || !message.trim()}
      >
        {pending ? "Sending…" : "Send message"}
      </Btn>
    </form>
  );
}

/** Top-bar trigger for the help panel. */
export function HelpButton() {
  const { open } = useHelp();
  return (
    <button type="button" className="topbar-icon-btn" onClick={open} aria-label="Help and support">
      <Ic.q style={{ width: 16, height: 16 }} />
    </button>
  );
}
