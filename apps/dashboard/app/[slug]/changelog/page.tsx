import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listPublicChangelog } from "@/lib/changelog";
import { FollowForm } from "../FollowForm";
import { PublicShell, dayLabel, loadPublicWorkspace, publicMetadata } from "../PublicShell";

// Fresh on every request: turning the pages off takes effect at once.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { slug: string } }): Promise<Metadata> {
  const ws = await loadPublicWorkspace(params.slug);
  return ws ? publicMetadata(ws, "changelog", `What ${ws.name} shipped and changed, newest first.`) : {};
}

export default async function PublicChangelogPage({ params }: { params: { slug: string } }) {
  const ws = await loadPublicWorkspace(params.slug);
  if (!ws) notFound();
  const entries = await listPublicChangelog(ws.id);

  return (
    <PublicShell ws={ws} page="changelog" title="Changelog" lede={`What ${ws.name} shipped and changed, newest first.`} width={720}>
      <section aria-labelledby="updates-head" className="card col gap-3" style={{ padding: 20 }}>
        <div className="col gap-1">
          <h2 id="updates-head" style={{ fontSize: "var(--fs-lg)" }}>Get updates by email</h2>
          <p className="text-sm note">
            An email when {ws.name} posts something new. You confirm from your inbox first, and every email has a link to stop.
          </p>
        </div>
        <FollowForm slug={ws.slug} initiativeId={null} label="Your email" cta="Email me updates" />
      </section>

      {entries.length === 0 ? (
        <p className="text-md note">No updates yet. Check back soon.</p>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {entries.map(e => (
            <li key={e.id} style={{ borderTop: "var(--border)", padding: "28px 0" }}>
              <article className="col gap-2" style={{ overflowWrap: "anywhere" }}>
                {e.publishedAt && (
                  <time className="eyebrow" dateTime={new Date(e.publishedAt).toISOString()}>{dayLabel(e.publishedAt)}</time>
                )}
                <h2 style={{ fontSize: "var(--fs-xl)", lineHeight: 1.25 }}>{e.title}</h2>
                {e.body.trim() && (
                  <p className="text-md note" style={{ whiteSpace: "pre-wrap", maxWidth: "64ch" }}>{e.body.trim()}</p>
                )}
              </article>
            </li>
          ))}
        </ol>
      )}
    </PublicShell>
  );
}
