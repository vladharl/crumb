import { db } from "./client";
import {
  workspaces, workspaceUsers, accounts, accountUsers, items, replies,
  initiatives, statusEvents,
} from "./schema";

async function main() {
  console.log("Seeding Crumb…");

  // Wipe (idempotent reseed). statusEvents + replies cascade from items;
  // initiatives must be cleared explicitly (items.initiative_id is ON DELETE
  // SET NULL, so deleting items alone leaves initiative rows behind).
  await db.delete(statusEvents);
  await db.delete(replies);
  await db.delete(items);
  await db.delete(initiatives);
  await db.delete(accountUsers);
  await db.delete(accounts);
  await db.delete(workspaceUsers);
  await db.delete(workspaces);

  const [southbeam] = await db.insert(workspaces).values({
    slug: "southbeam",
    name: "Southbeam",
  }).returning();
  if (!southbeam) throw new Error("workspace insert failed");

  const wsUsers = await db.insert(workspaceUsers).values([
    { workspaceId: southbeam.id, email: "lina@southbeam.io",  name: "Lina Rivers", role: "admin", initials: "LR" },
    { workspaceId: southbeam.id, email: "sarah@southbeam.io", name: "Sarah Klein", role: "admin", initials: "SK" },
    { workspaceId: southbeam.id, email: "jamie@southbeam.io", name: "Jamie Kim",   role: "pm",    initials: "JK" },
    { workspaceId: southbeam.id, email: "ravi@southbeam.io",  name: "Ravi Patel",  role: "pm",    initials: "RP" },
  ]).returning();
  const byInitials = Object.fromEntries(wsUsers.map(u => [u.initials, u]));

  const acctRows = await db.insert(accounts).values([
    { workspaceId: southbeam.id, name: "Acme Co",      arrCents: 4_800_000, since: new Date("2024-06-01") },
    { workspaceId: southbeam.id, name: "Lumen Health", arrCents: 2_100_000, since: new Date("2024-09-12") },
    { workspaceId: southbeam.id, name: "Pinedrop",     arrCents:   900_000, since: new Date("2025-01-15") },
    { workspaceId: southbeam.id, name: "Vora Studio",  arrCents:   600_000, since: new Date("2025-02-04") },
    { workspaceId: southbeam.id, name: "Stratus Labs", arrCents: 3_400_000, since: new Date("2024-08-22") },
  ]).returning();
  const byAcctName = Object.fromEntries(acctRows.map(a => [a.name, a]));

  const acctUserRows = await db.insert(accountUsers).values([
    { workspaceId: southbeam.id, accountId: byAcctName["Acme Co"].id,      email: "maya@acme.co",       name: "Maya",  role: "admin",  initials: "MA" },
    { workspaceId: southbeam.id, accountId: byAcctName["Acme Co"].id,      email: "dev@acme.co",        name: "Dev",   role: "member", initials: "DV" },
    { workspaceId: southbeam.id, accountId: byAcctName["Acme Co"].id,      email: "admin@acme.co",      name: "Admin", role: "admin",  initials: "AD" },
    { workspaceId: southbeam.id, accountId: byAcctName["Lumen Health"].id, email: "anika@lumen.health", name: "Anika", role: "admin",  initials: "AN" },
    { workspaceId: southbeam.id, accountId: byAcctName["Lumen Health"].id, email: "marco@lumen.health", name: "Marco", role: "member", initials: "MK" },
    { workspaceId: southbeam.id, accountId: byAcctName["Pinedrop"].id,     email: "tao@pinedrop.com",   name: "Tao",   role: "member", initials: "TO" },
    { workspaceId: southbeam.id, accountId: byAcctName["Vora Studio"].id,  email: "sam@vora.studio",    name: "Sam",   role: "member", initials: "SM" },
    { workspaceId: southbeam.id, accountId: byAcctName["Stratus Labs"].id, email: "lin@stratus.dev",    name: "Lin",   role: "member", initials: "LN" },
  ]).returning();
  const byAcctUserName = Object.fromEntries(acctUserRows.map(u => [`${u.name}@${u.accountId}`, u]));
  const pick = (name: string, acctName: string) => byAcctUserName[`${name}@${byAcctName[acctName].id}`];

  // ── Initiatives (vendor-side roadmap buckets) ──────────────────
  // Themed rollups the team plans against. Each lands in a Now/Next/Later
  // roadmap column (or stays Unscheduled), with a status and an owner — so the
  // Initiatives board and public roadmap read like a real product plan, not an
  // empty shell. Feedback items below are linked into these by `initiative` key.
  type InitiativeSeed = {
    key: string;            // local handle used to link items
    name: string;
    description: string;
    status: string;         // open | in_progress | shipped | parked
    roadmapColumn: string | null; // now | next | later | null (Unscheduled)
    order: number;
    color: string;
    owner: keyof typeof byInitials;
    isPublic: boolean;
  };
  const initiativeSeeds: InitiativeSeed[] = [
    { key: "exports",  name: "CSV & funnel exports",        status: "in_progress", roadmapColumn: "now",   order: 0, color: "#E27D3A", owner: "LR", isPublic: true,
      description: "One-click export of cohort and funnel data — CSV first, XLSX to follow. Top ask from accounts prepping quarterly business reviews." },
    { key: "notify",   name: "Real-time notifications",     status: "in_progress", roadmapColumn: "now",   order: 1, color: "#6B8E5A", owner: "LR", isPublic: true,
      description: "Push status changes and replies to Slack and outbound webhooks, so teams hear about movement without living in the dashboard." },
    { key: "sso",      name: "Enterprise SSO & SAML",       status: "open",        roadmapColumn: "next",  order: 0, color: "#4A2E1F", owner: "SK", isPublic: true,
      description: "SAML/Okta sign-in with group-to-role mapping and a custom embedded domain. Gating renewals on the two largest accounts." },
    { key: "api",      name: "API rate-limit headroom",     status: "open",        roadmapColumn: "next",  order: 1, color: "#B45F23", owner: "RP", isPublic: false,
      description: "Raise burst ceilings and return clean 429s with Retry-After. Internal reliability track surfaced by API consumers." },
    { key: "mobile",   name: "Mobile & localization polish", status: "open",       roadmapColumn: "later", order: 0, color: "#D4A24C", owner: "JK", isPublic: true,
      description: "Fix tablet/landscape layouts and respect locale in dates and number formats across the embedded views." },
    { key: "retention", name: "Cohort retention accuracy",  status: "shipped",     roadmapColumn: null,    order: 0, color: "#8A8278", owner: "JK", isPublic: true,
      description: "Corrected the per-cohort retention math and added a reconciliation test. Shipped in v2.3." },
  ];

  let initSeq = 1;
  const initRows = await db.insert(initiatives).values(
    initiativeSeeds.map(s => ({
      workspaceId: southbeam.id,
      seq: initSeq++,
      shortId: `IN-${initSeq - 1}`,
      name: s.name,
      description: s.description,
      status: s.status,
      color: s.color,
      roadmapColumn: s.roadmapColumn,
      roadmapOrder: s.order,
      isPublic: s.isPublic,
      ownerWorkspaceUserId: byInitials[s.owner].id,
    })),
  ).returning();
  const byInit = Object.fromEntries(initiativeSeeds.map((s, i) => [s.key, initRows[i]]));
  await db.update(workspaces).set({ nextInitiativeSeq: initSeq }).where(__eq(workspaces.id, southbeam.id));

  // Helper: insert item with auto-incrementing per-workspace short_id
  type ItemSeed = {
    title: string;
    type: string;
    status: string;
    acct: string;
    submitter: string;
    assignee?: keyof typeof byInitials;
    initiative?: keyof typeof byInit;
    body?: string;
    createdAtOffsetMin?: number;
  };
  const itemSeeds: ItemSeed[] = [
    { title: "Bulk export from cohort view as CSV",        type: "idea",        status: "review",   acct: "Acme Co",      submitter: "Maya",  assignee: "LR", initiative: "exports",   createdAtOffsetMin: 60 * 24 * 8,
      body: "Trying to pull cohort data into our QBR deck and ending up screenshotting each panel. A CSV export from the cohort view would save us hours every quarter." },
    { title: "Mobile layout breaks on iPad landscape",     type: "bug",         status: "review",   acct: "Acme Co",      submitter: "Maya",  assignee: "LR", initiative: "mobile",    createdAtOffsetMin: 60 * 5 },
    { title: "Slack DM when status changes",               type: "idea",        status: "planned",  acct: "Lumen Health", submitter: "Anika", assignee: "LR", initiative: "notify",    createdAtOffsetMin: 60 * 24 },
    { title: "API returns 429 under burst load",           type: "question",    status: "open",     acct: "Acme Co",      submitter: "Dev",                   initiative: "api",       createdAtOffsetMin: 60 * 24 },
    { title: "Per-cohort retention math seems off",        type: "bug",         status: "review",   acct: "Lumen Health", submitter: "Marco", assignee: "JK", initiative: "retention", createdAtOffsetMin: 60 * 48 },
    { title: "Webhook for status change",                  type: "idea", status: "open",     acct: "Vora Studio",  submitter: "Sam",                   initiative: "notify",    createdAtOffsetMin: 60 * 48 },
    { title: "Custom embedded domain",                     type: "idea",        status: "planned",  acct: "Acme Co",      submitter: "Admin", assignee: "LR", initiative: "sso",       createdAtOffsetMin: 60 * 24 * 3 },
    { title: "Datepicker doesn't respect locale",          type: "bug",         status: "review",   acct: "Pinedrop",     submitter: "Tao",   assignee: "JK", initiative: "mobile",    createdAtOffsetMin: 60 * 24 * 4 },
    { title: "SSO via Okta — more groups",                 type: "idea", status: "progress", acct: "Stratus Labs", submitter: "Lin",   assignee: "LR", initiative: "sso",       createdAtOffsetMin: 60 * 24 * 5 },
    { title: "Export funnel data as XLSX",                 type: "idea",        status: "open",     acct: "Lumen Health", submitter: "Anika",                 initiative: "exports",   createdAtOffsetMin: 60 * 24 * 7 },
  ];

  const now = Date.now();
  let seq = 247; // align with the design fixtures starting at FB-247 going down
  const insertedItems = [];
  for (const it of itemSeeds) {
    const submitter = pick(it.submitter, it.acct);
    if (!submitter) throw new Error(`Missing submitter ${it.submitter} in ${it.acct}`);
    const ts = new Date(now - (it.createdAtOffsetMin ?? 0) * 60_000);
    const [row] = await db.insert(items).values({
      workspaceId: southbeam.id,
      accountId: byAcctName[it.acct].id,
      submitterId: submitter.id,
      assigneeId: it.assignee ? byInitials[it.assignee].id : null,
      initiativeId: it.initiative ? byInit[it.initiative].id : null,
      seq,
      shortId: `FB-${seq}`,
      title: it.title,
      body: it.body ?? "",
      type: it.type,
      status: it.status,
      createdAt: ts,
      updatedAt: ts,
    }).returning();
    insertedItems.push(row!);
    seq--;
  }

  // bump next_item_seq so future inserts continue past 247
  await db.update(workspaces).set({ nextItemSeq: 248 }).where(__eq(workspaces.id, southbeam.id));

  // Replies on the first item (FB-247) — the canonical thread fixture
  const headItem = insertedItems[0];
  const maya = pick("Maya", "Acme Co");
  const lina = byInitials["LR"];
  const jamie = byInitials["JK"];
  if (headItem && maya && lina && jamie) {
    const t = headItem.createdAt.getTime();
    await db.insert(replies).values([
      { itemId: headItem.id, accountUserId: maya.id, body: headItem.body, internal: false,
        createdAt: new Date(t) },
      { itemId: headItem.id, workspaceUserId: lina.id, internal: false,
        body: "Makes sense. Two quick scoping questions before we commit — per-cohort CSV, or funnel breakdown too? Blocker for this QBR, or nice-to-have?",
        createdAt: new Date(t + 60_000 * 60 * 24) },
      { itemId: headItem.id, accountUserId: maya.id, internal: false,
        body: "Per-cohort priority. Funnel breakdown nice-to-have. Yes, blocking — QBR is in three weeks.",
        createdAt: new Date(t + 60_000 * 60 * 48) },
      { itemId: headItem.id, workspaceUserId: lina.id, internal: true,
        body: "@JK — is this two days or two weeks? Acme's QBR is in three weeks, third account asking, totaling $186k ARR.",
        createdAt: new Date(t + 60_000 * 60 * 50) },
      { itemId: headItem.id, workspaceUserId: jamie.id, internal: true,
        body: "Per-cohort CSV is a day, two with QA. Funnel adds three to four days. Ship CSV alone in v2.4.",
        createdAt: new Date(t + 60_000 * 60 * 52) },
    ]);
  }

  // ── Status history (audit trail) ───────────────────────────────
  // A few realistic transitions so the audit view and item timelines aren't
  // blank. Every item gets its creation event; a handful get follow-on moves.
  const lr = byInitials["LR"];
  const jk = byInitials["JK"];
  const statusRows: (typeof statusEvents.$inferInsert)[] = [];
  for (const it of insertedItems) {
    statusRows.push({ itemId: it.id, fromStatus: null, toStatus: "open", byWorkspaceUserId: lr?.id ?? null, at: it.createdAt });
  }
  const moveLater = (item: typeof insertedItems[number], mins: number) =>
    new Date(item.createdAt.getTime() + mins * 60_000);
  if (insertedItems[0]) // FB-247 → triaged into review
    statusRows.push({ itemId: insertedItems[0].id, fromStatus: "open", toStatus: "review", byWorkspaceUserId: lr?.id ?? null, at: moveLater(insertedItems[0], 60 * 26) });
  if (insertedItems[8]) { // FB-239 SSO → planned → in progress
    statusRows.push({ itemId: insertedItems[8].id, fromStatus: "open", toStatus: "planned", byWorkspaceUserId: lr?.id ?? null, at: moveLater(insertedItems[8], 60 * 12) });
    statusRows.push({ itemId: insertedItems[8].id, fromStatus: "planned", toStatus: "progress", byWorkspaceUserId: lr?.id ?? null, at: moveLater(insertedItems[8], 60 * 40) });
  }
  if (insertedItems[4]) // FB-243 retention bug → review
    statusRows.push({ itemId: insertedItems[4].id, fromStatus: "open", toStatus: "review", byWorkspaceUserId: jk?.id ?? null, at: moveLater(insertedItems[4], 60 * 8) });
  await db.insert(statusEvents).values(statusRows);

  console.log(`Done. Workspace ${southbeam.slug}, ${insertedItems.length} items, ${acctRows.length} accounts, ${initRows.length} initiatives, ${statusRows.length} status events.`);
  process.exit(0);
}

// Inline eq import to avoid extra top-level import noise
import { eq as __eq } from "drizzle-orm";

main().catch(err => {
  console.error(err);
  process.exit(1);
});
