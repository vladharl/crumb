import { db } from "./client";
import {
  workspaces, workspaceUsers, accounts, accountUsers, items, replies,
} from "./schema";

async function main() {
  console.log("Seeding Crumb…");

  // Wipe (idempotent reseed)
  await db.delete(replies);
  await db.delete(items);
  await db.delete(accountUsers);
  await db.delete(accounts);
  await db.delete(workspaceUsers);
  await db.delete(workspaces);

  const [northbeam] = await db.insert(workspaces).values({
    slug: "northbeam",
    name: "Northbeam",
  }).returning();
  if (!northbeam) throw new Error("workspace insert failed");

  const wsUsers = await db.insert(workspaceUsers).values([
    { workspaceId: northbeam.id, email: "lina@northbeam.io",  name: "Lina Rivers", role: "admin", initials: "LR" },
    { workspaceId: northbeam.id, email: "sarah@northbeam.io", name: "Sarah Klein", role: "admin", initials: "SK" },
    { workspaceId: northbeam.id, email: "jamie@northbeam.io", name: "Jamie Kim",   role: "pm",    initials: "JK" },
    { workspaceId: northbeam.id, email: "ravi@northbeam.io",  name: "Ravi Patel",  role: "pm",    initials: "RP" },
  ]).returning();
  const byInitials = Object.fromEntries(wsUsers.map(u => [u.initials, u]));

  const acctRows = await db.insert(accounts).values([
    { workspaceId: northbeam.id, name: "Acme Co",      arrCents: 4_800_000, since: new Date("2024-06-01") },
    { workspaceId: northbeam.id, name: "Lumen Health", arrCents: 2_100_000, since: new Date("2024-09-12") },
    { workspaceId: northbeam.id, name: "Pinedrop",     arrCents:   900_000, since: new Date("2025-01-15") },
    { workspaceId: northbeam.id, name: "Vora Studio",  arrCents:   600_000, since: new Date("2025-02-04") },
    { workspaceId: northbeam.id, name: "Stratus Labs", arrCents: 3_400_000, since: new Date("2024-08-22") },
  ]).returning();
  const byAcctName = Object.fromEntries(acctRows.map(a => [a.name, a]));

  const acctUserRows = await db.insert(accountUsers).values([
    { workspaceId: northbeam.id, accountId: byAcctName["Acme Co"].id,      email: "maya@acme.co",       name: "Maya",  role: "admin",  initials: "MA" },
    { workspaceId: northbeam.id, accountId: byAcctName["Acme Co"].id,      email: "dev@acme.co",        name: "Dev",   role: "member", initials: "DV" },
    { workspaceId: northbeam.id, accountId: byAcctName["Acme Co"].id,      email: "admin@acme.co",      name: "Admin", role: "admin",  initials: "AD" },
    { workspaceId: northbeam.id, accountId: byAcctName["Lumen Health"].id, email: "anika@lumen.health", name: "Anika", role: "admin",  initials: "AN" },
    { workspaceId: northbeam.id, accountId: byAcctName["Lumen Health"].id, email: "marco@lumen.health", name: "Marco", role: "member", initials: "MK" },
    { workspaceId: northbeam.id, accountId: byAcctName["Pinedrop"].id,     email: "tao@pinedrop.com",   name: "Tao",   role: "member", initials: "TO" },
    { workspaceId: northbeam.id, accountId: byAcctName["Vora Studio"].id,  email: "sam@vora.studio",    name: "Sam",   role: "member", initials: "SM" },
    { workspaceId: northbeam.id, accountId: byAcctName["Stratus Labs"].id, email: "lin@stratus.dev",    name: "Lin",   role: "member", initials: "LN" },
  ]).returning();
  const byAcctUserName = Object.fromEntries(acctUserRows.map(u => [`${u.name}@${u.accountId}`, u]));
  const pick = (name: string, acctName: string) => byAcctUserName[`${name}@${byAcctName[acctName].id}`];

  // Helper: insert item with auto-incrementing per-workspace short_id
  type ItemSeed = {
    title: string;
    type: string;
    status: string;
    acct: string;
    submitter: string;
    assignee?: keyof typeof byInitials;
    body?: string;
    createdAtOffsetMin?: number;
  };
  const itemSeeds: ItemSeed[] = [
    { title: "Bulk export from cohort view as CSV",        type: "idea",        status: "review",   acct: "Acme Co",      submitter: "Maya",  assignee: "LR", createdAtOffsetMin: 60 * 24 * 8,
      body: "Trying to pull cohort data into our QBR deck and ending up screenshotting each panel. A CSV export from the cohort view would save us hours every quarter." },
    { title: "Mobile layout breaks on iPad landscape",     type: "bug",         status: "review",   acct: "Acme Co",      submitter: "Maya",  assignee: "LR", createdAtOffsetMin: 60 * 5 },
    { title: "Slack DM when status changes",               type: "idea",        status: "planned",  acct: "Lumen Health", submitter: "Anika", assignee: "LR", createdAtOffsetMin: 60 * 24 },
    { title: "API returns 429 under burst load",           type: "question",    status: "open",     acct: "Acme Co",      submitter: "Dev",                   createdAtOffsetMin: 60 * 24 },
    { title: "Per-cohort retention math seems off",        type: "bug",         status: "review",   acct: "Lumen Health", submitter: "Marco", assignee: "JK", createdAtOffsetMin: 60 * 48 },
    { title: "Webhook for status change",                  type: "idea", status: "open",     acct: "Vora Studio",  submitter: "Sam",                   createdAtOffsetMin: 60 * 48 },
    { title: "Custom embedded domain",                     type: "idea",        status: "planned",  acct: "Acme Co",      submitter: "Admin", assignee: "LR", createdAtOffsetMin: 60 * 24 * 3 },
    { title: "Datepicker doesn't respect locale",          type: "bug",         status: "review",   acct: "Pinedrop",     submitter: "Tao",   assignee: "JK", createdAtOffsetMin: 60 * 24 * 4 },
    { title: "SSO via Okta — more groups",                 type: "idea", status: "progress", acct: "Stratus Labs", submitter: "Lin",   assignee: "LR", createdAtOffsetMin: 60 * 24 * 5 },
    { title: "Export funnel data as XLSX",                 type: "idea",        status: "open",     acct: "Lumen Health", submitter: "Anika",                 createdAtOffsetMin: 60 * 24 * 7 },
  ];

  const now = Date.now();
  let seq = 247; // align with the design fixtures starting at FB-247 going down
  const insertedItems = [];
  for (const it of itemSeeds) {
    const submitter = pick(it.submitter, it.acct);
    if (!submitter) throw new Error(`Missing submitter ${it.submitter} in ${it.acct}`);
    const ts = new Date(now - (it.createdAtOffsetMin ?? 0) * 60_000);
    const [row] = await db.insert(items).values({
      workspaceId: northbeam.id,
      accountId: byAcctName[it.acct].id,
      submitterId: submitter.id,
      assigneeId: it.assignee ? byInitials[it.assignee].id : null,
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
  await db.update(workspaces).set({ nextItemSeq: 248 }).where(__eq(workspaces.id, northbeam.id));

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

  console.log(`Done. Workspace ${northbeam.slug}, ${insertedItems.length} items, ${acctRows.length} accounts.`);
  process.exit(0);
}

// Inline eq import to avoid extra top-level import noise
import { eq as __eq } from "drizzle-orm";

main().catch(err => {
  console.error(err);
  process.exit(1);
});
