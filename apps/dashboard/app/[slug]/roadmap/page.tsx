import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listPublicRoadmap } from "@/lib/roadmap";
import { InitiativeStatusPill } from "@/app/(app)/initiatives/InitiativeChip";
import { FollowForm } from "../FollowForm";
import { PublicShell, dayLabel, loadPublicWorkspace, publicMetadata } from "../PublicShell";

// Fresh on every request: turning the pages off, or an initiative private,
// takes effect at once.
export const dynamic = "force-dynamic";

const LANES = [
  { key: "now", label: "Now" },
  { key: "next", label: "Next" },
  { key: "later", label: "Later" },
  { key: "shipped", label: "Shipped" },
] as const;

const short = (s: string) => (s.length > 200 ? `${s.slice(0, 199).trimEnd()}…` : s);

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const ws = await loadPublicWorkspace(params.slug);
  return ws ? publicMetadata(ws, "roadmap", `What ${ws.name} is working on now, next and later, and what shipped recently.`) : {};
}

export default async function PublicRoadmapPage({ params }: { params: { slug: string } }) {
  const ws = await loadPublicWorkspace(params.slug);
  if (!ws) notFound();
  const entries = await listPublicRoadmap(ws.id);

  return (
    <PublicShell
      ws={ws}
      page="roadmap"
      title="Roadmap"
      lede={`What ${ws.name} is working on, and what shipped lately. Follow anything to get an email when it moves.`}
      width={1120}
    >
      {entries.length === 0 ? (
        <p className="text-md note">Nothing on the roadmap yet. Check back soon.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", gap: 24, alignItems: "start" }}>
          {LANES.map(lane => {
            const cards = entries.filter(e => e.lane === lane.key);
            return (
              <section key={lane.key} aria-labelledby={`lane-${lane.key}`} className="col gap-3">
                <h2
                  id={`lane-${lane.key}`}
                  style={{ fontSize: "var(--fs-sm)", textTransform: "uppercase", letterSpacing: "var(--ls-cap)" }}
                >
                  {lane.label}
                </h2>
                {cards.length === 0 && <p className="text-sm muted note">Nothing here right now.</p>}
                {cards.map(e => (
                  <article key={e.id} className="card col gap-3" style={{ padding: 16, overflowWrap: "anywhere" }}>
                    <div className="col gap-1">
                      <h3 style={{ fontSize: "var(--fs-lg)", lineHeight: 1.3 }}>{e.name}</h3>
                      {e.description && <p className="text-sm note">{short(e.description)}</p>}
                    </div>
                    <div className="row gap-2" style={{ flexWrap: "wrap" }}>
                      <InitiativeStatusPill status={e.status} />
                      {lane.key === "shipped" && e.shippedAt && (
                        <time className="text-xs muted" dateTime={e.shippedAt}>{dayLabel(e.shippedAt)}</time>
                      )}
                    </div>
                    {lane.key !== "shipped" && (
                      <details className="public-follow">
                        <summary className="btn sm">Follow</summary>
                        <FollowForm slug={ws.slug} initiativeId={e.id} label={`Email me when ${e.name} moves`} cta="Follow" />
                      </details>
                    )}
                  </article>
                ))}
              </section>
            );
          })}
        </div>
      )}
    </PublicShell>
  );
}
