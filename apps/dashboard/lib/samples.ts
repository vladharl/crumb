import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, accounts, accountUsers, initiatives, items, replies, statusEvents, workspaces } from "@crumb/db";

// Sample data for a brand-new Cloud workspace, so the inbox, the tour and
// Insights show the product working before the first real customer writes in.
// Everything hangs off one account, "Sample Co", tagged with
// SAMPLE_ACCOUNT_EXTERNAL_ID in accounts.external_crm_id (the only external id
// accounts have). Its provider stays null, so the CRM sync never links or
// renames it and the integrations page never counts it.
//
// Samples never send anything. The rows go in directly rather than through the
// mutation cores, so no event, webhook or chat card fires and no usage counter
// moves. The customers have reserved .invalid addresses, which the reply and
// status emails skip, and are unsubscribed from everything, which the roadmap
// and changelog emails honour.

export const SAMPLE_ACCOUNT_EXTERNAL_ID = "crumb-sample";

// Provisioning seeds into a brand-new workspace, so the sample initiative is
// always its IN-1 (initiative numbers are never reused).
const SAMPLE_INITIATIVE_SHORT_ID = "IN-1";
const SAMPLE_INITIATIVE_NAME = "Reporting and exports";

const CUSTOMERS = {
  maya: { name: "Maya Chen", initials: "MC", role: "admin" },
  dev:  { name: "Dev Patel", initials: "DP", role: "member" },
  ana:  { name: "Ana Ruiz",  initials: "AR", role: "member" },
};
const emailOf = (handle: string) => `${handle}@sample-co.invalid`;

type SampleItem = {
  type: "bug" | "idea" | "question";
  by: keyof typeof CUSTOMERS;
  daysAgo: number;
  title: string;
  body: string;            // the customer's opening message
  initiative?: boolean;    // part of the sample initiative
  // After the opening message: `h` hours after the item arrived.
  thread?: { h: number; vendor: boolean; body: string }[];
  moves?: { h: number; to: string }[]; // the last one is the item's status
};

// Oldest first, so FB-1 is the oldest. One of each loop state the inbox shows.
const SAMPLE_ITEMS: SampleItem[] = [
  { // Closed: fixed, shipped, and the customer heard back.
    type: "bug", by: "dev", daysAgo: 12,
    title: "Dashboard times show in UTC, not our timezone",
    body: "Every timestamp on the dashboard is in UTC. Our team is in Chicago, so we do the math in our heads all day.",
    thread: [
      { h: 3, vendor: true, body: "Thanks, Dev. We can see it too, and a fix is in progress." },
      { h: 120, vendor: true, body: "Shipped! Times on the dashboard now follow your workspace timezone. Thanks for flagging it." },
    ],
    moves: [{ h: 3, to: "progress" }, { h: 120, to: "shipped" }],
  },
  { // Decided and answered: the ball is in the customer's court.
    type: "idea", by: "maya", daysAgo: 9,
    title: "Sign in with Okta",
    body: "Our security team wants everyone on Okta by the end of the quarter. Is SSO on your roadmap?",
    thread: [{ h: 20, vendor: true, body: "It is. Okta sign-in is planned for next quarter, and we'll update you here when it's ready." }],
    moves: [{ h: 20, to: "planned" }],
  },
  { // The ball came back: they answered your question, so it's your turn again.
    type: "idea", by: "maya", daysAgo: 6, initiative: true,
    title: "Email the usage report to our team every Monday",
    body: "Every Monday someone exports the usage report and pastes it into Slack. A scheduled email would save us that step.",
    thread: [
      { h: 4, vendor: true, body: "Love this. Should it go to a fixed list of people, or to everyone on your account?" },
      { h: 26, vendor: false, body: "A fixed list works. Just our three team leads." },
    ],
    moves: [{ h: 4, to: "review" }],
  },
  { // Answered, waiting to hear back.
    type: "question", by: "ana", daysAgo: 3,
    title: "Can viewers see billing details?",
    body: "We're adding our finance team as viewers. Will they see invoices, or is that admins only?",
    thread: [{ h: 2, vendor: true, body: "Admins only. Viewers can read feedback and the roadmap, but invoices stay hidden." }],
  },
  { // New and unanswered: waiting on you.
    type: "bug", by: "dev", daysAgo: 1, initiative: true,
    title: "CSV export stops at 10,000 rows",
    body: "Our accounts export cuts off at 10,000 rows. We have about 14,000, so the rest never make it into the file.",
  },
];

const sampleAccountOf = (workspaceId: string) =>
  and(eq(accounts.workspaceId, workspaceId), eq(accounts.externalCrmId, SAMPLE_ACCOUNT_EXTERNAL_ID));

export async function hasSampleData(workspaceId: string): Promise<boolean> {
  const [row] = await db.select({ id: accounts.id }).from(accounts).where(sampleAccountOf(workspaceId)).limit(1);
  return !!row;
}

// Seed the sample set in one transaction. Only provisioning calls this, right
// after creating the workspace, so the FB/IN counters still start at 1 (a
// workspace that already has FB-1 fails the unique short id and seeds nothing).
// Vendor replies and status moves are by the workspace's first admin.
export async function seedSampleData(workspaceId: string, adminUserId: string): Promise<void> {
  const now = Date.now();
  const at = (daysAgo: number, hours = 0) => new Date(now - daysAgo * 86_400_000 + hours * 3_600_000);

  await db.transaction(async (tx) => {
    const [account] = await tx.insert(accounts).values({
      workspaceId,
      name: "Sample Co",
      arrCents: 4_800_000,
      since: at(240),
      externalCrmId: SAMPLE_ACCOUNT_EXTERNAL_ID,
    }).returning({ id: accounts.id });

    const people = await tx.insert(accountUsers).values(
      Object.entries(CUSTOMERS).map(([handle, c]) => ({
        workspaceId,
        accountId: account.id,
        email: emailOf(handle),
        ...c,
        unsubscribedAll: true,
      })),
    ).returning({ id: accountUsers.id, email: accountUsers.email });
    const customerId = (handle: string) => people.find(p => p.email === emailOf(handle))!.id;

    const [initiative] = await tx.insert(initiatives).values({
      workspaceId,
      seq: 1,
      shortId: SAMPLE_INITIATIVE_SHORT_ID,
      name: SAMPLE_INITIATIVE_NAME,
      description: "Exports that include every row, and reports that arrive on a schedule.",
      status: "in_progress",
      roadmapColumn: "now",
      isPublic: false, // never on the customer-facing roadmap
      ownerWorkspaceUserId: adminUserId,
    }).returning({ id: initiatives.id });

    const created = await tx.insert(items).values(SAMPLE_ITEMS.map((s, i) => ({
      workspaceId,
      accountId: account.id,
      submitterId: customerId(s.by),
      initiativeId: s.initiative ? initiative.id : null,
      seq: i + 1,
      shortId: `FB-${i + 1}`,
      title: s.title,
      body: s.body,
      type: s.type,
      status: s.moves?.at(-1)?.to ?? "open",
      source: "widget", // as if submitted through the widget, like most real items
      createdAt: at(s.daysAgo),
      updatedAt: at(s.daysAgo, Math.max(0, ...[...(s.thread ?? []), ...(s.moves ?? [])].map(e => e.h))),
    }))).returning({ id: items.id, seq: items.seq });
    const itemId = (i: number) => created.find(c => c.seq === i + 1)!.id;

    await tx.insert(replies).values(SAMPLE_ITEMS.flatMap((s, i) => [
      { h: 0, vendor: false, body: s.body },
      ...(s.thread ?? []),
    ].map(t => ({
      itemId: itemId(i),
      workspaceUserId: t.vendor ? adminUserId : null,
      accountUserId: t.vendor ? null : customerId(s.by),
      body: t.body,
      internal: false,
      createdAt: at(s.daysAgo, t.h),
    }))));

    await tx.insert(statusEvents).values(SAMPLE_ITEMS.flatMap((s, i) => [
      { itemId: itemId(i), fromStatus: null, toStatus: "open", byWorkspaceUserId: null, at: at(s.daysAgo) },
      ...(s.moves ?? []).map((m, j, moves) => ({
        itemId: itemId(i),
        fromStatus: j === 0 ? "open" : moves[j - 1].to,
        toStatus: m.to,
        byWorkspaceUserId: adminUserId,
        at: at(s.daysAgo, m.h),
      })),
    ]));

    await tx.update(workspaces)
      .set({ nextItemSeq: SAMPLE_ITEMS.length + 1, nextInitiativeSeq: 2 })
      .where(eq(workspaces.id, workspaceId));
  });
}

// Remove the sample account and everything hanging off it, in one transaction:
// its items (their replies, status events, customer notifications and
// initiative links cascade with them), its customers, and the sample
// initiative while it's still the sample: not once real items have joined it,
// and not once an admin has renamed it or made it public. Session-free; the
// settings action owns the session and the admin check. Returns how many items went.
export async function removeSampleData(workspaceId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const sample = await tx.select({ id: accounts.id }).from(accounts).where(sampleAccountOf(workspaceId));
    if (sample.length === 0) return 0;
    const accountIds = sample.map(a => a.id);

    const gone = await tx.delete(items)
      .where(and(eq(items.workspaceId, workspaceId), inArray(items.accountId, accountIds)))
      .returning({ id: items.id });

    const [initiative] = await tx.select({ id: initiatives.id }).from(initiatives)
      .where(and(
        eq(initiatives.workspaceId, workspaceId),
        eq(initiatives.shortId, SAMPLE_INITIATIVE_SHORT_ID),
        eq(initiatives.name, SAMPLE_INITIATIVE_NAME),
        eq(initiatives.isPublic, false),
      ))
      .limit(1);
    if (initiative) {
      const [kept] = await tx.select({ id: items.id }).from(items).where(eq(items.initiativeId, initiative.id)).limit(1);
      if (!kept) await tx.delete(initiatives).where(eq(initiatives.id, initiative.id));
    }

    // Customers cascade with the account.
    await tx.delete(accounts).where(inArray(accounts.id, accountIds));
    return gone.length;
  });
}
