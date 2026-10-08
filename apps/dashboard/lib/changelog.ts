import "server-only";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import {
  db,
  changelogEntries,
  initiatives,
  items,
  accountUsers,
  roadmapFollows,
  customerNotifications,
  type Workspace,
} from "@crumb/db";
import { emailConfigured, sendShippedAnnouncement } from "@/lib/email";
import { WIDGET_SOURCE } from "@/lib/feedback/source";
import type { NotifySkipReason } from "@/lib/notify/customer-plan";
import { roadmapEmailPlan } from "@/lib/roadmap-notify";
import { updateItemStatus, type VendorActor } from "@/lib/items/mutations";
import { loopOpenSql, notMergedSql } from "@/lib/loop-sql";
import { emitEvent } from "@/lib/webhooks";
import { log } from "@/lib/log";

// Announce-shipped (closes the open loop). When an initiative moves to "shipped"
// we draft a changelog entry and the vendor is asked to announce it; publishing
// emails everyone who asked (item submitters on that initiative) or follows it,
// and can move its open requests to Shipped in the same step. Drafting is
// intentionally non-AI for v1 — a clean starting point the team edits — so no
// edition-swap module is needed. Entries written by hand email no one.

export type ChangelogDraft = { id: string; title: string; body: string; publishedAt: Date | null };

// The initiative's changelog entry, drafting one from its name and description
// when it has none yet. Null when the initiative isn't this workspace's, or the
// write failed. publishedAt null means a draft waiting for a human to publish.
export async function draftChangelogForInitiative(
  ws: Pick<Workspace, "id">,
  initiativeId: string,
): Promise<ChangelogDraft | null> {
  try {
    const cols = {
      id: changelogEntries.id,
      title: changelogEntries.title,
      body: changelogEntries.body,
      publishedAt: changelogEntries.publishedAt,
    };
    const [existing] = await db
      .select(cols)
      .from(changelogEntries)
      .where(and(eq(changelogEntries.workspaceId, ws.id), eq(changelogEntries.initiativeId, initiativeId)))
      .limit(1);
    if (existing) return existing;

    const [ini] = await db
      .select({ name: initiatives.name, description: initiatives.description })
      .from(initiatives)
      .where(and(eq(initiatives.workspaceId, ws.id), eq(initiatives.id, initiativeId)))
      .limit(1);
    if (!ini) return null;

    const [created] = await db
      .insert(changelogEntries)
      .values({
        workspaceId: ws.id,
        initiativeId,
        title: ini.name,
        body: ini.description ?? "",
        isPublic: true,
        // publishedAt stays null → it's a draft until a human publishes.
      })
      .returning(cols);
    log.info("changelog draft created", { scope: "crumb/changelog", workspaceId: ws.id, initiativeId });
    return created ?? null;
  } catch (err) {
    log.error("changelog draft failed", { scope: "crumb/changelog", err });
    return null;
  }
}

// Who asked for or follows the initiative but can't be emailed, and why: the
// tools their requests came in through, no real address, or updates turned off.
export type Skipped = { count: number; sources: string[]; noEmail: boolean; muted: boolean };

// What the ship prompt and the Publish confirm show. `reach` counts customers
// the announcement would email (emailOn says whether email is set up at all);
// `openItems` is how many linked requests publishing could mark Shipped.
export type Audience = { reach: number; skipped: Skipped; emailOn: boolean; openItems: number };

// The prompt shown when an initiative ships with its entry still a draft.
export type Announce = { entryId: string; title: string; body: string; audience: Audience };

type Recipient = { id: string; email: string; unsubToken: string; reason: "asked" | "follow" };

const addr = (email: string) => email.trim().toLowerCase();

// Everyone the announcement is for: item submitters on the initiative and its
// followers, deduped by address. Anyone reachable through either counts once,
// and asking wins over following for the email's footer. The rest are skipped.
async function audienceOf(workspaceId: string, initiativeId: string): Promise<{ recipients: Recipient[]; skipped: Skipped }> {
  const person = {
    id: accountUsers.id,
    email: accountUsers.email,
    unsubToken: accountUsers.unsubToken,
    unsubscribedAll: accountUsers.unsubscribedAll,
    notifyRoadmap: accountUsers.notifyRoadmap,
  };
  const [asked, follows] = await Promise.all([
    db
      .select({ ...person, source: items.source })
      .from(items)
      .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
      .where(and(eq(items.workspaceId, workspaceId), eq(items.initiativeId, initiativeId))),
    db
      .select(person)
      .from(roadmapFollows)
      .innerJoin(accountUsers, eq(accountUsers.id, roadmapFollows.accountUserId))
      .where(eq(roadmapFollows.initiativeId, initiativeId)),
  ]);

  const reached = new Map<string, Recipient>();
  const missed: Array<{ key: string; why: NotifySkipReason; source: string | null }> = [];
  for (const p of [
    ...asked.map(a => ({ ...a, reason: "asked" as const })),
    ...follows.map(f => ({ ...f, source: WIDGET_SOURCE, reason: "follow" as const })),
  ]) {
    const key = addr(p.email);
    // Askers by their item's source (only widget-origin ones opted into
    // Crumb's loop, lib/feedback/source); everyone by their own prefs.
    const plan = roadmapEmailPlan(p, p.source);
    if (!plan.willEmail) missed.push({ key, why: plan.reason, source: p.source });
    else if (reached.get(key)?.reason !== "asked") {
      reached.set(key, { id: p.id, email: p.email, unsubToken: p.unsubToken, reason: p.reason });
    }
  }

  const left = missed.filter(m => !reached.has(m.key));
  return {
    recipients: [...reached.values()],
    skipped: {
      count: new Set(left.map(m => m.key)).size,
      sources: [...new Set(left.flatMap(m => (m.why === "source" && m.source ? [m.source] : [])))],
      noEmail: left.some(m => m.why === "no_email"),
      muted: left.some(m => m.why === "muted" || m.why === "unsubscribed"),
    },
  };
}

// The initiative's requests still open: what publishing can mark Shipped.
function openLinked(workspaceId: string, initiativeId: string) {
  return and(
    eq(items.workspaceId, workspaceId),
    eq(items.initiativeId, initiativeId),
    notMergedSql(items.mergedIntoId),
    loopOpenSql(items.status),
  );
}

export async function announcementAudience(workspaceId: string, initiativeId: string): Promise<Audience> {
  const [{ recipients, skipped }, [open]] = await Promise.all([
    audienceOf(workspaceId, initiativeId),
    db.select({ n: sql<number>`COUNT(*)::int` }).from(items).where(openLinked(workspaceId, initiativeId)),
  ]);
  return { reach: recipients.length, skipped, emailOn: emailConfigured(), openItems: open?.n ?? 0 };
}

// ponytail: four at a time keeps a publish inside one request without bursting
// the email provider's rate limit (inbox bulk status does the same). Move the
// sends to the sweep cron if audiences grow into the thousands.
async function fewAtATime<T>(list: T[], fn: (t: T) => Promise<void>): Promise<void> {
  const queue = [...list];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) await fn(t);
  }));
}

export type PublishResult =
  | { ok: true; announced: false }
  | {
      ok: true;
      announced: true;
      delivered: number; // customers a real provider accepted the email for (never stdout)
      failed: number;    // sends that didn't go through, with email set up
      skipped: Skipped;
      emailOn: boolean;
      marked: number;    // open requests moved to Shipped
    }
  | { ok: false; error: string };

// Publishes a draft. A hand-written entry is only published. An initiative's
// entry is also emailed to its audience, and with `markShipped` (the acting
// teammate) its open requests move to Shipped through the status core. A
// customer the announcement reached isn't sent a Shipped status email too, nor
// one about a request merged into those; their shipped requests get the loop
// ledger row from the announcement instead.
export async function publishChangelogEntry(
  ws: Workspace,
  entryId: string,
  opts: { origin?: string | null; markShipped?: VendorActor } = {},
): Promise<PublishResult> {
  // Claiming publishedAt in the same write makes a second publish (a double
  // click, another tab) a no-op instead of a second round of emails.
  const [entry] = await db
    .update(changelogEntries)
    .set({ publishedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(changelogEntries.workspaceId, ws.id),
      eq(changelogEntries.id, entryId),
      isNull(changelogEntries.publishedAt),
    ))
    .returning();
  if (!entry) {
    const [exists] = await db
      .select({ id: changelogEntries.id })
      .from(changelogEntries)
      .where(and(eq(changelogEntries.workspaceId, ws.id), eq(changelogEntries.id, entryId)))
      .limit(1);
    return { ok: false, error: exists ? "already_decided" : "not_found" };
  }
  const initiativeId = entry.initiativeId;
  if (!initiativeId) return { ok: true, announced: false };

  const origin = opts.origin ?? null;
  const emailOn = emailConfigured();
  const [[ini], { recipients, skipped }] = await Promise.all([
    db
      .select({ name: initiatives.name })
      .from(initiatives)
      .where(and(eq(initiatives.workspaceId, ws.id), eq(initiatives.id, initiativeId)))
      .limit(1),
    audienceOf(ws.id, initiativeId),
  ]);

  let delivered = 0;
  let failed = 0;
  const told = new Set<string>(); // addresses a real provider accepted
  await fewAtATime(recipients, async r => {
    try {
      const accepted = await sendShippedAnnouncement({
        to: r.email,
        workspaceName: ws.name,
        // The thread key the initiative's roadmap moves use (lib/roadmap-notify).
        initiativeName: ini?.name ?? entry.title,
        title: entry.title,
        body: entry.body,
        reason: r.reason,
        productUrl: ws.productUrl,
        accent: ws.accent,
        // Same one-click unsubscribe shape as lib/roadmap-notify.ts.
        unsubscribeUrl: origin ? `${origin}/api/v1/unsubscribe?u=${r.id}&t=${r.unsubToken}&scope=roadmap` : null,
      });
      if (accepted) {
        delivered++;
        told.add(addr(r.email));
      } else if (emailOn) failed++;
    } catch (err) {
      if (emailOn) failed++;
      log.error("shipped announcement failed", { scope: "crumb/changelog", err });
    }
  });

  let marked = 0;
  if (opts.markShipped) {
    const actor = opts.markShipped;
    const open = await db
      .select({ shortId: items.shortId })
      .from(items)
      .where(openLinked(ws.id, initiativeId));
    await fewAtATime(open, async it => {
      // The announcement is the email: whoever it reached isn't sent a second,
      // about this request or one merged into it. Whoever it failed to reach
      // gets their usual Shipped email instead.
      const r = await updateItemStatus(
        actor,
        { itemShortId: it.shortId, status: "shipped", origin },
        { alreadyTold: told },
      ).catch((err: unknown) => {
        log.error("mark shipped failed", { scope: "crumb/changelog", shortId: it.shortId, err });
        return { ok: false as const };
      });
      if (r.ok) marked++;
    });
  }

  if (told.size > 0) await recordTold(ws, initiativeId, told);

  log.info("changelog published", { scope: "crumb/changelog", workspaceId: ws.id, entryId, delivered, failed, marked });
  return { ok: true, announced: true, delivered, failed, skipped, emailOn, marked };
}

// Loop ledger: whoever the announcement reached was told their shipped requests
// shipped, one row per request, as a Shipped status email would have recorded.
// Never throws: the emails are out, so bookkeeping can't fail the publish.
async function recordTold(ws: Workspace, initiativeId: string, told: Set<string>): Promise<void> {
  try {
    const shipped = await db
      .select({
        id: items.id,
        shortId: items.shortId,
        title: items.title,
        type: items.type,
        submitterId: items.submitterId,
        email: accountUsers.email,
      })
      .from(items)
      .innerJoin(accountUsers, eq(accountUsers.id, items.submitterId))
      .where(and(eq(items.workspaceId, ws.id), eq(items.initiativeId, initiativeId), eq(items.status, "shipped")));
    const rows = shipped.filter(s => told.has(addr(s.email)));
    if (rows.length === 0) return;
    await db.insert(customerNotifications).values(
      rows.map(s => ({ itemId: s.id, accountUserId: s.submitterId, kind: "status", toStatus: "shipped" })),
    );
    const at = new Date().toISOString();
    for (const s of rows) {
      void emitEvent(ws.id, {
        type: "customer.notified",
        workspace: ws.slug,
        item: { short_id: s.shortId, title: s.title, type: s.type },
        notification: { kind: "status", channel: "email", to_status: "shipped" },
        at,
      });
    }
  } catch (err) {
    log.error("announcement ledger failed", { scope: "crumb/changelog", err });
  }
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
