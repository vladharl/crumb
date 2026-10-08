import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db, initiatives, publicFollows, workspaces } from "@crumb/db";
import type { OutgoingEmail } from "@/lib/email/provider";

// A real provider (SMTP, faked at the transport) so sends count, unlike stdout.
// Set before lib/email picks and caches its provider.
const h = vi.hoisted(() => {
  process.env.CRUMB_EMAIL_PROVIDER = "smtp";
  process.env.SMTP_HOST = "smtp.test";
  process.env.CRUMB_EMAIL_FROM = "Crumb <crumb@mail.example.com>";
  process.env.CRUMB_APP_URL = "https://crumb.test";
  return { sent: [] as OutgoingEmail[] };
});
vi.mock("@/lib/email/smtp", () => ({
  makeSmtpProvider: () => ({
    name: "smtp",
    send: async (m: OutgoingEmail) => {
      h.sent.push(m);
      return { ok: true as const, providerMessageId: null };
    },
  }),
}));

import { notifyPublicFollowers, requestPublicFollow, sweepUnconfirmedFollows } from "@/lib/public-follows";
import { GET as confirmGet, POST as confirmPost } from "@/app/[slug]/confirm/route";
import { GET as unsubGet, POST as unsubPost } from "@/app/[slug]/unsubscribe/route";

// Anonymous follows from the public pages: double opt-in (a mail scanner
// opening the link confirms nothing), a repeat follow that says and sends
// nothing, one email per address per change, the caller's skip list, a
// one-click unsubscribe that stops the address, and silence once the pages
// are off.
//
// Against Postgres (DATABASE_URL, migrated via `pnpm db:migrate`). Skipped
// locally when no database answers; CI has one, so there it fails instead.
const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const tag = randomUUID().slice(0, 8);
const created: string[] = [];

const post = (href: string, form: Record<string, string> = {}) =>
  new Request(href, { method: "POST", body: new URLSearchParams(form) });

describe.skipIf(!reachable && !process.env.CI)("public follows", () => {
  afterAll(async () => {
    delete process.env.CRUMB_EMAIL_PROVIDER;
    delete process.env.SMTP_HOST;
    delete process.env.CRUMB_APP_URL;
    if (created.length) await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  it("confirms on the click, emails each address once, and stops on one click", async () => {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `public-${tag}`, name: "Acme", publicPagesEnabled: true })
      .returning({ id: workspaces.id, slug: workspaces.slug });
    created.push(ws!.id);
    const [ini] = await db.insert(initiatives)
      .values({ workspaceId: ws!.id, seq: 1, shortId: "IN-1", name: "Dark mode", isPublic: true, roadmapColumn: "next" })
      .returning({ id: initiatives.id });
    const ann = `ann-${tag}@example.com`;
    const bob = `bob-${tag}@example.com`;

    const follow = async (email: string, initiativeId: string | null) => {
      h.sent.length = 0;
      await requestPublicFollow({ slug: ws!.slug, initiativeId, email, ip: `ip-${tag}`, origin: "https://crumb.test" });
      return h.sent[0];
    };
    const move = () => notifyPublicFollowers({
      workspaceId: ws!.id, initiativeId: ini!.id, kind: "roadmap_move", title: "Dark mode", summary: "moved to Now", url: null,
    });
    const entry = {
      workspaceId: ws!.id, initiativeId: ini!.id, kind: "changelog" as const, title: "Dark mode is here", summary: "Try it.", url: null,
    };

    // Following mails a confirmation link, and nothing else until it's clicked.
    const ask = await follow(ann.toUpperCase(), ini!.id);
    expect(ask).toMatchObject({ to: ann, subject: "Confirm updates from Acme" });
    expect(await move()).toBe(0);

    // The link's GET only asks; the Confirm button's POST follows.
    const page = await confirmGet(new Request(ask!.link!));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Get an email when Dark mode moves on Acme");
    expect(await move()).toBe(0);
    await confirmPost(post(ask!.link!));

    // Following again sends nothing (and the form answers the same either way).
    expect(await follow(ann, ini!.id)).toBeUndefined();

    // Ann and Bob both follow every update too.
    for (const email of [ann, bob]) await confirmPost(post((await follow(email, null))!.link!));

    h.sent.length = 0;
    expect(await move()).toBe(1);
    expect(h.sent[0]).toMatchObject({ to: ann, subject: "Moved to Now: Dark mode" });

    // Ann follows twice but hears once; Bob was already told by the caller.
    h.sent.length = 0;
    expect(await notifyPublicFollowers({ ...entry, skip: [bob.toUpperCase()] })).toBe(1);
    expect(h.sent.map(m => m.to)).toEqual([ann]);
    expect(h.sent[0]!.subject).toBe("New from Acme: Dark mode is here");

    // The inbox's one-click unsubscribe stops all of Ann's follows; a forged link changes nothing.
    const unsub = h.sent[0]!.headers!["List-Unsubscribe"]!.slice(1, -1);
    expect((await unsubGet(new Request(unsub))).status).toBe(200);
    const forged = unsub.replace(/([?&])s=[^&]+/, "$1s=AAAAAAAAAAAAAAAAAAAAAA");
    expect((await unsubPost(post(forged, { "List-Unsubscribe": "One-Click" }))).status).toBe(400);
    expect(await move()).toBe(1);
    const res = await unsubPost(post(unsub, { "List-Unsubscribe": "One-Click" }));
    expect(res.status).toBe(200);
    expect(await move()).toBe(0);

    // Bob still follows, until the pages are turned off.
    expect(await notifyPublicFollowers(entry)).toBe(1);
    await db.update(workspaces).set({ publicPagesEnabled: false }).where(eq(workspaces.id, ws!.id));
    expect(await notifyPublicFollowers(entry)).toBe(0);
  });

  it("forgets an address whose confirmation lapsed, unless it asked again", async () => {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `sweep-${tag}`, name: "Acme", publicPagesEnabled: true })
      .returning({ id: workspaces.id, slug: workspaces.slug });
    created.push(ws!.id);
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    const who = (name: string) => `${name}-${tag}@example.com`;
    await db.insert(publicFollows).values([
      { email: who("lapsed"), createdAt: old },
      { email: who("kept"), createdAt: old, confirmedAt: old },
      { email: who("again"), createdAt: old },
    ].map((f, i) => ({ ...f, workspaceId: ws!.id, tokenHash: `${ws!.id}-${i}` })));
    // A fresh link restarts its week.
    await requestPublicFollow({ slug: ws!.slug, initiativeId: null, email: who("again"), ip: `ip-sweep-${tag}`, origin: "https://crumb.test" });

    await sweepUnconfirmedFollows();
    const left = await db.select({ email: publicFollows.email }).from(publicFollows).where(eq(publicFollows.workspaceId, ws!.id));
    expect(left.map(r => r.email).sort()).toEqual([who("again"), who("kept")]);
  });

  it("refuses an expired or mangled confirmation link", async () => {
    for (const t of [`1000000000.${"a".repeat(43)}`, "nope"]) {
      expect((await confirmGet(new Request(`https://crumb.test/acme/confirm?t=${t}`))).status).toBe(400);
    }
  });
});
