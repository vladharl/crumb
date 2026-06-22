import "server-only";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import {
  db,
  changelogEntries,
  initiatives,
  items,
  accountUsers,
  roadmapFollows,
  type Workspace,
} from "@crumb/db";
import { sendRoadmapUpdateNotification } from "@/lib/email";
import { WIDGET_SOURCE } from "@/lib/feedback/source";
import { log } from "@/lib/log";

// Announce-shipped (closes the open loop). When an initiative moves to "shipped"
// we auto-draft a changelog entry; a human reviews + publishes it, which fans the
// news out to everyone who asked (item submitters on that initiative + explicit
// roadmap followers). Drafting is intentionally non-AI for v1 — a clean starting
// point the team edits — so no edition-swap module is needed.

// Idempotently create a DRAFT entry for a just-shipped initiative. No-op if an
// entry for this initiative already exists. Fire-and-forget from the initiative
// status mutation.
export async function draftChangelogForInitiative(ws: Workspace, initiativeId: string): Promise<void> {
  try {
    const [existing] = await db
      .select({ id: changelogEntries.id })
      .from(changelogEntries)
      .where(and(eq(changelogEntries.workspaceId, ws.id), eq(changelogEntries.initiativeId, initiativeId)))
      .limit(1);
    if (existing) return;

    const [ini] = await db
      .select({ name: initiatives.name, description: initiatives.description })
      .from(initiatives)
      .where(and(eq(initiatives.workspaceId, ws.id), eq(initiatives.id, initiativeId)))
      .limit(1);
    if (!ini) return;

    await db.insert(changelogEntries).values({
      workspaceId: ws.id,
      initiativeId,
      title: ini.name,
      body: ini.description ?? "",
      isPublic: true,
      // publishedAt stays null → it's a draft until a human publishes.
    });
    log.info("changelog draft created", { scope: "crumb/changelog", workspaceId: ws.id, initiativeId });
  } catch (err) {
    log.error("changelog draft failed", { scope: "crumb/changelog", err });
  }
}

type Recipient = { id: string; email: string; unsubToken: string };

// Distinct recipients for an initiative's announcement: item submitters on that
// initiative + explicit roadmap followers, minus anyone muted. Deduped by email.
// (notifyRoadmapFollowers covers followers-only on roadmap *moves*; a changelog
// announcement additionally reaches everyone who asked.)
async function announcementRecipients(workspaceId: string, initiativeId: string): Promise<Recipient[]> {
  const submitters = await db
    .selectDistinct({ id: accountUsers.id, email: accountUsers.email, unsubToken: accountUsers.unsubToken })
    .from(items)
    .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
    .where(
      and(
        eq(items.workspaceId, workspaceId),
        eq(items.initiativeId, initiativeId),
        // Only announce to widget-origin submitters — pulled-connector customers
        // never opted into Crumb's loop (see lib/feedback/source).
        or(isNull(items.source), eq(items.source, WIDGET_SOURCE)),
        eq(accountUsers.notifyRoadmap, true),
        eq(accountUsers.unsubscribedAll, false),
      ),
    );

  const followers = await db
    .select({ id: accountUsers.id, email: accountUsers.email, unsubToken: accountUsers.unsubToken })
    .from(roadmapFollows)
    .innerJoin(accountUsers, eq(accountUsers.id, roadmapFollows.accountUserId))
    .where(
      and(
        eq(roadmapFollows.initiativeId, initiativeId),
        eq(accountUsers.notifyRoadmap, true),
        eq(accountUsers.unsubscribedAll, false),
      ),
    );

  const byEmail = new Map<string, Recipient>();
  for (const r of [...submitters, ...followers]) byEmail.set(r.email.toLowerCase(), r);
  return [...byEmail.values()];
}

export type PublishResult = { ok: true; notified: number } | { ok: false; error: string };

// Publish a draft entry and announce it. Idempotent: a re-publish of an
// already-published entry returns ok without re-sending (publishedAt is the
// guard). Email sends are best-effort and bounded.
export async function publishChangelogEntry(ws: Workspace, entryId: string): Promise<PublishResult> {
  const [entry] = await db
    .select()
    .from(changelogEntries)
    .where(and(eq(changelogEntries.workspaceId, ws.id), eq(changelogEntries.id, entryId)))
    .limit(1);
  if (!entry) return { ok: false, error: "not_found" };
  if (entry.publishedAt) return { ok: true, notified: 0 }; // already announced

  await db
    .update(changelogEntries)
    .set({ publishedAt: new Date(), updatedAt: new Date() })
    .where(eq(changelogEntries.id, entryId));

  if (!entry.initiativeId) return { ok: true, notified: 0 };
  const recipients = await announcementRecipients(ws.id, entry.initiativeId);
  const base = process.env.CRUMB_APP_URL?.replace(/\/+$/, "") ?? "";
  for (const r of recipients) {
    void sendRoadmapUpdateNotification({
      to: r.email,
      workspaceName: ws.name,
      initiativeName: entry.title,
      change: entry.body || "Shipped 🎉",
      productUrl: ws.productUrl,
      // Same one-click unsubscribe shape as lib/roadmap-notify.ts.
      unsubscribeUrl: base ? `${base}/api/v1/unsubscribe?u=${r.id}&t=${r.unsubToken}&scope=roadmap` : null,
    });
  }
  log.info("changelog published", { scope: "crumb/changelog", workspaceId: ws.id, entryId, notified: recipients.length });
  return { ok: true, notified: recipients.length };
}

export type ChangelogListEntry = {
  id: string;
  title: string;
  body: string;
  isPublic: boolean;
  publishedAt: Date | null;
  initiativeId: string | null;
  createdAt: Date;
};

// All entries for the dashboard (drafts + published), newest first.
export async function listChangelogEntries(workspaceId: string): Promise<ChangelogListEntry[]> {
  return db
    .select({
      id: changelogEntries.id,
      title: changelogEntries.title,
      body: changelogEntries.body,
      isPublic: changelogEntries.isPublic,
      publishedAt: changelogEntries.publishedAt,
      initiativeId: changelogEntries.initiativeId,
      createdAt: changelogEntries.createdAt,
    })
    .from(changelogEntries)
    .where(eq(changelogEntries.workspaceId, workspaceId))
    .orderBy(changelogEntries.createdAt);
}

// Published, public entries for the widget "What's new" tab / public API.
export async function listPublicChangelog(workspaceId: string): Promise<ChangelogListEntry[]> {
  return db
    .select({
      id: changelogEntries.id,
      title: changelogEntries.title,
      body: changelogEntries.body,
      isPublic: changelogEntries.isPublic,
      publishedAt: changelogEntries.publishedAt,
      initiativeId: changelogEntries.initiativeId,
      createdAt: changelogEntries.createdAt,
    })
    .from(changelogEntries)
    .where(
      and(
        eq(changelogEntries.workspaceId, workspaceId),
        eq(changelogEntries.isPublic, true),
        isNotNull(changelogEntries.publishedAt),
      ),
    )
    .orderBy(changelogEntries.publishedAt);
}
