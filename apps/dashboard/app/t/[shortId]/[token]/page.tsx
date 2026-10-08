import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StatusPill, type Status } from "@crumb/ui";
import { loadHostedThread } from "@/lib/hosted-thread";

export const dynamic = "force-dynamic";

// The path is a capability: keep it out of search results and Referer headers.
export const metadata: Metadata = {
  title: "Your feedback",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const day = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const TEXT = { margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap" } as const;

// The read-only thread a customer email links to when the workspace has no
// Product URL (lib/hosted-thread). It reads as the vendor's, like the email:
// their name and dot lead, and replies happen in their Feedback tab.
export default async function HostedThreadPage({ params }: { params: { shortId: string; token: string } }) {
  const thread = await loadHostedThread(params.shortId, params.token);
  if (!thread) notFound();
  const { item, messages } = thread;
  const accent = /^#[0-9a-f]{6}$/i.test(item.accent) ? item.accent : null;

  return (
    <main style={{ minHeight: "100vh", padding: "48px 16px" }}>
      <div className="col gap-4" style={{ maxWidth: 560, margin: "0 auto" }}>
        <span className="row gap-2 serif text-lg">
          {accent && <span aria-hidden style={{ color: accent }}>&#9679;</span>}
          {item.workspaceName}
        </span>

        <article className="card card-body col gap-4">
          <header className="col gap-2">
            <h1 style={{ fontSize: "var(--fs-xl)", lineHeight: 1.25 }}>{item.title}</h1>
            <span className="row gap-2" style={{ flexWrap: "wrap" }}>
              <StatusPill status={item.status as Status} />
              <span className="text-xs muted">Sent {day(item.createdAt)}</span>
            </span>
          </header>
          {item.body && <p className="text-md" style={TEXT}>{item.body}</p>}

          {messages.map(m => (
            <section key={m.id} className="col gap-2" style={{ borderTop: "var(--border)", paddingTop: 16 }}>
              <span className="text-sm">
                {m.author && <span className="fw-med">{m.author}</span>}
                <span className="muted">{m.author ? " · " : ""}{m.fromVendor ? `${item.workspaceName} · ` : ""}{day(m.createdAt)}</span>
              </span>
              {m.body && <p className="text-md" style={TEXT}>{m.body}</p>}
              {m.files.map(f => (
                <a key={f.href} href={f.href} target="_blank" rel="noreferrer" className="text-sm" style={{ color: "var(--accent-deep)" }}>
                  {f.name}
                </a>
              ))}
            </section>
          ))}
        </article>

        <p className="text-sm muted note">Reply anytime from the Feedback tab in {item.workspaceName}.</p>
      </div>
    </main>
  );
}
