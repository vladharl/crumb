import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNotNull, isNull, lt, or, type SQL } from "drizzle-orm";
import { db, initiatives, publicFollows, workspaces } from "@crumb/db";
import { sendPublicFollowConfirm, sendPublicFollowUpdate } from "@/lib/email";
import { fewAtATime } from "@/lib/few-at-a-time";
import { originFromHeaders } from "@/lib/origin";
import { checkRateLimitAsync } from "@/lib/rate-limit";
import { signReplyToken, verifyReplyToken } from "@/lib/reply-token";
import { onPublicRoadmapSql } from "@/lib/roadmap";
import { log } from "@/lib/log";

// Anonymous email follows from the public pages (app/[slug]): a visitor follows
// one public initiative on /<slug>/roadmap, or every update on
// /<slug>/changelog (initiative null). Double opt-in: the form only mails a
// confirmation link, and updates go to confirmed follows that haven't
// unsubscribed, each with a one-click unsubscribe. Nothing here sends while
// the workspace's public pages are off.

// Any slug a workspace can have (older signups could end in "-"); junk such as
// %00 is turned away before it reaches Postgres.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFIRM_TTL_DAYS = 7;
const HOUR = 3600;

// The workspace behind /<slug>/…, only while an admin has its public pages on.
// The slug check keeps junk (a NUL byte) away from Postgres, which would throw.
export async function publicWorkspace(slug: string) {
  if (!SLUG_RE.test(slug)) return null;
  const [ws] = await db
    .select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name, accent: workspaces.accent })
    .from(workspaces)
    .where(and(eq(workspaces.slug, slug), eq(workspaces.publicPagesEnabled, true)))
    .limit(1);
  return ws ?? null;
}

// The confirmation token: "<expiry, unix seconds>.<32 random bytes>". Only its
// sha256 is stored, so the expiry can't be edited without missing the row.
export function newConfirmToken(nowMs = Date.now()): { token: string; hash: string } {
  const exp = Math.floor(nowMs / 1000) + CONFIRM_TTL_DAYS * 24 * HOUR;
  const token = `${exp}.${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Update emails can't carry the confirmation token (only its hash is kept), so
// their unsubscribe link is an HMAC over the follow's id under the workspace
// signing secret, like the hosted thread link (lib/hosted-thread).
// ponytail: rotating the signing secret retires these links too (the next email
// carries a fresh one). Give follows their own secret if that ever bites.
const unsubPayload = (followId: string) => `public-unsub:${followId}`;
export const publicUnsubscribePath = (slug: string, followId: string, secret: string) =>
  `/${slug}/unsubscribe?f=${followId}&s=${signReplyToken(unsubPayload(followId), secret)}`;

// A Follow or "Email me updates" submission (app/[slug]/actions). Silent on
// purpose: a fresh follow, one already confirmed, a rate limit, pages turned
// off all look the same to the visitor, so the form never says whether an
// address follows. Never throws.
export async function requestPublicFollow(input: {
  slug: string;
  initiativeId: string | null;
  email: string;
  ip: string;
  origin: string | null;
}): Promise<void> {
  try {
    const email = input.email.trim().toLowerCase();
    // Per address as well as per IP, so nobody can flood one inbox with confirmations.
    const [byIp, byAddress] = await Promise.all([
      checkRateLimitAsync(`public-follow:ip:${input.ip}`, { capacity: 20, refillPerSec: 20 / HOUR }),
      checkRateLimitAsync(`public-follow:to:${email}`, { capacity: 5, refillPerSec: 5 / HOUR }),
    ]);
    if (!byIp.ok || !byAddress.ok || !input.origin) return;

    const ws = await publicWorkspace(input.slug);
    if (!ws) return;
    let initiativeName: string | null = null;
    if (input.initiativeId !== null) {
      if (!UUID_RE.test(input.initiativeId)) return;
      const [ini] = await db
        .select({ name: initiatives.name })
        .from(initiatives)
        .where(and(
          eq(initiatives.id, input.initiativeId),
          eq(initiatives.workspaceId, ws.id),
          onPublicRoadmapSql(),
        ))
        .limit(1);
      if (!ini) return;
      initiativeName = ini.name;
    }

    const { token, hash } = newConfirmToken();
    const [created] = await db
      .insert(publicFollows)
      .values({ workspaceId: ws.id, initiativeId: input.initiativeId, email, tokenHash: hash })
      .onConflictDoNothing()
      .returning({ id: publicFollows.id });
    if (!created) {
      // Already there. A confirmed follow that's still on keeps its links and
      // gets no mail; otherwise a fresh link replaces the old one (and restarts
      // the clock sweepUnconfirmedFollows reads). Only that link's click clears
      // an unsubscribe, never the form.
      const [renewed] = await db
        .update(publicFollows)
        .set({ tokenHash: hash, createdAt: new Date() })
        .where(and(
          eq(publicFollows.workspaceId, ws.id),
          input.initiativeId === null ? isNull(publicFollows.initiativeId) : eq(publicFollows.initiativeId, input.initiativeId),
          eq(publicFollows.email, email),
          or(isNull(publicFollows.confirmedAt), isNotNull(publicFollows.unsubscribedAt)),
        ))
        .returning({ id: publicFollows.id });
      if (!renewed) return;
    }

    await sendPublicFollowConfirm({
      to: email,
      workspaceName: ws.name,
      accent: ws.accent,
      initiativeName,
      link: `${input.origin}/${ws.slug}/confirm?t=${token}`,
      ttlDays: CONFIRM_TTL_DAYS,
    });
  } catch (err) {
    log.error("public follow failed", { scope: "crumb/public-follows", err });
  }
}

export type FollowTarget = {
  id: string;
  workspaceId: string;
  email: string;
  /** The initiative followed; null for every update. */
  initiativeName: string | null;
  ws: { name: string; accent: string; slug: string; pagesOn: boolean };
};

async function findFollow(where: SQL): Promise<(FollowTarget & { secret: string }) | null> {
  const [row] = await db
    .select({
      id: publicFollows.id,
      workspaceId: publicFollows.workspaceId,
      email: publicFollows.email,
      initiativeName: initiatives.name,
      secret: workspaces.signingSecret,
      ws: { name: workspaces.name, accent: workspaces.accent, slug: workspaces.slug, pagesOn: workspaces.publicPagesEnabled },
    })
    .from(publicFollows)
    .innerJoin(workspaces, eq(workspaces.id, publicFollows.workspaceId))
    .leftJoin(initiatives, eq(initiatives.id, publicFollows.initiativeId))
    .where(where)
    .limit(1);
  return row ?? null;
}

// The follow a confirmation link names, while the link is fresh. Null for a
// forged, mangled or expired token.
export async function followFromConfirmToken(token: string): Promise<FollowTarget | null> {
  const exp = /^(\d{1,12})\.[\w-]{43}$/.exec(token)?.[1];
  if (!exp || Number(exp) * 1000 <= Date.now()) return null;
  const row = await findFollow(eq(publicFollows.tokenHash, hashToken(token)));
  if (!row) return null;
  const { secret: _secret, ...follow } = row;
  return follow;
}

// The follow an update email's unsubscribe link names. Null unless its
// signature checks out (constant-time, lib/reply-token).
export async function followFromUnsubscribeLink(followId: string, sig: string): Promise<FollowTarget | null> {
  if (!UUID_RE.test(followId) || !sig) return null;
  const row = await findFollow(eq(publicFollows.id, followId));
  if (!row || !verifyReplyToken(unsubPayload(followId), sig, row.secret)) return null;
  const { secret: _secret, ...follow } = row;
  return follow;
}

export async function confirmPublicFollow(followId: string): Promise<void> {
  await db
    .update(publicFollows)
    .set({ confirmedAt: new Date(), unsubscribedAt: null })
    .where(eq(publicFollows.id, followId));
}

// Stops every public update this workspace sends the address, not just the
// follow behind the email: whoever clicks Unsubscribe wants the mail to stop.
export async function unsubscribePublicFollows(f: Pick<FollowTarget, "workspaceId" | "email">): Promise<void> {
  await db
    .update(publicFollows)
    .set({ unsubscribedAt: new Date() })
    .where(and(
      eq(publicFollows.workspaceId, f.workspaceId),
      eq(publicFollows.email, f.email),
      isNull(publicFollows.unsubscribedAt),
    ));
}

const originOf = (url: string | null) => {
  try { return url ? new URL(url).origin : null; } catch { return null; }
};

// Emails the public followers about one public change. A roadmap move goes to
// that initiative's followers (never for an initiative that isn't public); a
// changelog entry to the all-updates followers plus its initiative's. Only
// confirmed follows nobody unsubscribed, only while the pages are on, once per
// address, and never to an address in `skip` (lowercased: customers the caller
// already emailed about it). Returns how many a real provider accepted.
// Best-effort: never throws.
export async function notifyPublicFollowers(input: {
  workspaceId: string;
  initiativeId: string | null;
  kind: "roadmap_move" | "changelog";
  title: string;
  summary: string;
  url: string | null;
  skip?: Iterable<string>;
}): Promise<number> {
  try {
    const { initiativeId } = input;
    let scope: SQL | undefined;
    if (input.kind === "roadmap_move") {
      if (!initiativeId) return 0;
      scope = and(eq(publicFollows.initiativeId, initiativeId), eq(initiatives.isPublic, true));
    } else {
      scope = or(isNull(publicFollows.initiativeId), initiativeId ? eq(publicFollows.initiativeId, initiativeId) : undefined);
    }
    // Every email carries its unsubscribe link: no origin to build it on, no email.
    const origin = originFromHeaders(new Headers()) ?? originOf(input.url);
    if (!origin) return 0;

    const rows = await db
      .select({
        id: publicFollows.id,
        email: publicFollows.email,
        initiativeId: publicFollows.initiativeId,
        workspaceName: workspaces.name,
        accent: workspaces.accent,
        slug: workspaces.slug,
        secret: workspaces.signingSecret,
      })
      .from(publicFollows)
      .innerJoin(workspaces, eq(workspaces.id, publicFollows.workspaceId))
      .leftJoin(initiatives, eq(initiatives.id, publicFollows.initiativeId))
      .where(and(
        eq(publicFollows.workspaceId, input.workspaceId),
        eq(workspaces.publicPagesEnabled, true),
        isNotNull(publicFollows.confirmedAt),
        isNull(publicFollows.unsubscribedAt),
        scope,
      ));

    const told = new Set(Array.from(input.skip ?? [], e => e.trim().toLowerCase()));
    const once = rows.filter(r => {
      if (told.has(r.email)) return false;
      told.add(r.email);
      return true;
    });
    const page = input.kind === "roadmap_move" ? "roadmap" : "changelog";
    let sent = 0;
    // A publish waits on this for its toast's count.
    await fewAtATime(once, async r => {
      const accepted = await sendPublicFollowUpdate({
        to: r.email,
        workspaceName: r.workspaceName,
        accent: r.accent,
        kind: input.kind,
        title: input.title,
        summary: input.summary,
        url: input.url ?? `${origin}/${r.slug}/${page}`,
        scope: r.initiativeId ? "initiative" : "all",
        unsubscribeUrl: `${origin}${publicUnsubscribePath(r.slug, r.id, r.secret)}`,
      }).catch((err: unknown) => {
        log.error("public follower email failed", { scope: "crumb/public-follows", err });
        return false;
      });
      if (accepted) sent++;
    });
    return sent;
  } catch (err) {
    log.error("public follower notify failed", { scope: "crumb/public-follows", err });
    return 0;
  }
}

// Maintenance sweep (api/v1/internal/replay-sweep): forgets the addresses whose
// confirmation link lapsed unclicked and the ones that unsubscribed, so an
// address isn't kept once it can't be mailed.
export async function sweepUnconfirmedFollows(): Promise<{ unconfirmedFollowsDeleted: number }> {
  const gone = await db
    .delete(publicFollows)
    .where(or(
      and(
        isNull(publicFollows.confirmedAt),
        lt(publicFollows.createdAt, new Date(Date.now() - CONFIRM_TTL_DAYS * 24 * HOUR * 1000)),
      ),
      // An unsubscribed address has no further use (following again needs a
      // fresh confirmation), so it isn't kept either.
      isNotNull(publicFollows.unsubscribedAt),
    ))
    .returning({ id: publicFollows.id });
  return { unconfirmedFollowsDeleted: gone.length };
}
