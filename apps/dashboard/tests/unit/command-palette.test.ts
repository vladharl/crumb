import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { db, accounts, accountUsers, initiatives, items, workspaces } from "@crumb/db";
import { paletteSections, type CommandGroup, type Fetched, type PaletteResponse } from "@/components/CommandPalette";

// The ⌘K palette: what it lists for a query and role (pure), and its search
// route end to end against Postgres (DATABASE_URL, migrated), with the session
// mocked. The route half is skipped locally when no database answers; CI has
// one, so there it fails instead of skipping.

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getSession }));

import { GET } from "@/app/api/v1/palette/route";

const GROUPS: CommandGroup[] = [
  {
    label: "Actions",
    items: [
      { label: "Compose feedback", href: "/inbox?compose=1", roles: ["admin", "pm"] },
      { label: "Invite a teammate", href: "/settings/team", roles: ["admin"] },
      { label: "Install the widget", href: "/settings/install" },
    ],
  },
  {
    label: "Go to",
    items: [
      { label: "Settings → Integrations", href: "/settings/integrations", keywords: "slack jira" },
      { label: "Settings → Team & roles", href: "/settings/team", keywords: "members invite roles" },
    ],
  },
];

const labels = (sections: CommandGroup[]) => sections.map(s => [s.label, s.items.map(i => i.label)]);
const fetched = (q: string, feedback: Fetched["feedback"]): Fetched => ({ q, feedback, accounts: [], initiatives: [] });

describe("paletteSections", () => {
  it("hides role-gated actions until the role is known, and from roles that can't take them", () => {
    const actions = (role: string | null) => paletteSections(GROUPS, role, "", null)[0].items.map(i => i.label);
    expect(actions(null)).toEqual(["Install the widget"]);
    expect(actions("viewer")).toEqual(["Install the widget"]);
    expect(actions("pm")).toEqual(["Compose feedback", "Install the widget"]);
    expect(actions("admin")).toEqual(["Compose feedback", "Invite a teammate", "Install the widget"]);
  });

  it("matches every term in any order, tolerates a typo, and drops empty groups", () => {
    expect(labels(paletteSections(GROUPS, "admin", "team settings", null))).toEqual([["Go to", ["Settings → Team & roles"]]]);
    expect(labels(paletteSections(GROUPS, "admin", "intgrations", null))).toEqual([["Go to", ["Settings → Integrations"]]]);
    expect(paletteSections(GROUPS, "admin", "zzz", null)).toEqual([]);
  });

  it("shows fresh results as sent, keeps older ones only while they still match, and none for an empty query", () => {
    const rows = [
      { label: "Export to CSV", hint: "FB-1 · Open", href: "/thread/FB-1" },
      { label: "Bulk edit", hint: "FB-12 · Open", href: "/thread/FB-12" },
    ];
    // Typed past the answer: FB-1 no longer matches, so Enter can't open it.
    expect(labels(paletteSections(GROUPS, "pm", "FB-12", fetched("FB-1", rows)))).toEqual([["Feedback", ["Bulk edit"]]]);
    // The answer for this query is shown whole: the server also matched "fb12".
    expect(labels(paletteSections(GROUPS, "pm", " fb12 ", fetched("fb12", rows)))).toEqual([["Feedback", ["Export to CSV", "Bulk edit"]]]);
    expect(paletteSections(GROUPS, "pm", "", fetched("FB-1", rows)).map(s => s.label)).toEqual(["Actions", "Go to"]);
  });
});

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const tag = randomUUID().slice(0, 8);
const ws: string[] = [];

async function search(q: string): Promise<PaletteResponse> {
  const res = await GET(new Request(`http://localhost/api/v1/palette?q=${encodeURIComponent(q)}`));
  expect(res.status).toBe(200);
  return res.json();
}
const titles = async (q: string) => (await search(q)).feedback.map(f => f.label);

describe.skipIf(!reachable && !process.env.CI)("GET /api/v1/palette", () => {
  beforeAll(async () => {
    for (const name of ["mine", "theirs"]) {
      const [w] = await db.insert(workspaces).values({ slug: `palette-${name}-${tag}`, name }).returning({ id: workspaces.id });
      ws.push(w.id);
    }
    const [mine, theirs] = ws;
    const [acme, , their] = await db.insert(accounts).values([
      { workspaceId: mine, name: "Acme", arrCents: 4_800_000 },
      { workspaceId: mine, name: "Acme Labs" },
      { workspaceId: theirs, name: "Acme" },
    ]).returning({ id: accounts.id });
    const [pat] = await db.insert(accountUsers)
      .values({ workspaceId: mine, accountId: acme.id, email: `pat-${tag}@acme.test`, name: "Pat", initials: "P" })
      .returning({ id: accountUsers.id });
    const titled = [
      "Export to CSV", "50% off", "500 off", "a_b toggle",
      "Export audit log", "Export roadmap", "Export users", "Export invoices", "Export as PDF",
    ];
    // FB-n is created n minutes in, so a higher number is newer.
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n));
    await db.insert(items).values([
      { seq: 12, title: titled[0] }, { seq: 120, title: "Bulk edit" },
      ...titled.slice(1).map((title, i) => ({ seq: i + 1, title })),
    ].map(r => ({
      ...r, workspaceId: mine, accountId: acme.id, submitterId: pat.id, shortId: `FB-${r.seq}`, type: "idea", createdAt: at(r.seq),
    })));
    // The other workspace has a lookalike that must never come back.
    const [sam] = await db.insert(accountUsers)
      .values({ workspaceId: theirs, accountId: their.id, email: `sam-${tag}@acme.test`, name: "Sam", initials: "S" })
      .returning({ id: accountUsers.id });
    await db.insert(items).values({
      workspaceId: theirs, accountId: their.id, submitterId: sam.id, seq: 1, shortId: "FB-1", title: "Export to CSV", type: "idea",
    });
    await db.insert(initiatives).values([
      { workspaceId: mine, seq: 1, shortId: "IN-1", name: "CSV exports" },
      { workspaceId: theirs, seq: 1, shortId: "IN-1", name: "CSV exports" },
    ]);
    getSession.mockResolvedValue({ workspace: { id: mine }, user: { role: "viewer" } });
  });

  afterAll(async () => {
    if (!ws.length) return;
    await db.delete(items).where(inArray(items.workspaceId, ws));
    await db.delete(workspaces).where(inArray(workspaces.id, ws));
  });

  it("refuses without a session", async () => {
    getSession.mockResolvedValueOnce(null);
    expect((await GET(new Request("http://localhost/api/v1/palette?q=csv"))).status).toBe(401);
  });

  it("answers an empty query with the role alone", async () => {
    expect(await search("  ")).toEqual({ role: "viewer", feedback: [], accounts: [], initiatives: [] });
  });

  it("finds one item by its short id first, with or without the prefix or dash", async () => {
    for (const q of ["FB-12", "fb12", "12"]) {
      const { feedback } = await search(q);
      expect(feedback[0]).toEqual({ label: "Export to CSV", hint: "FB-12 · Open", href: "/thread/FB-12" });
    }
    expect((await search("FB-12")).feedback.map(f => f.hint)).toEqual(["FB-12 · Open", "FB-120 · Open"]);
  });

  it("matches title words in any order, in this workspace only", async () => {
    const res = await search("csv export");
    expect(res.feedback.map(f => f.href)).toEqual(["/thread/FB-12"]);
    expect(res.initiatives).toHaveLength(1);
    expect(res.initiatives[0]).toMatchObject({ label: "CSV exports", hint: "IN-1" });
  });

  it("reads % and _ literally", async () => {
    expect(await titles("50%")).toEqual(["50% off"]);
    expect(await titles("_")).toEqual(["a_b toggle"]);
  });

  it("caps each group, newest first", async () => {
    expect(await titles("export")).toEqual(["Export to CSV", "Export as PDF", "Export invoices", "Export users", "Export roadmap"]);
  });

  it("finds accounts by name, biggest ARR first, with the ARR as the hint", async () => {
    const { accounts: found } = await search("acme");
    expect(found.map(a => [a.label, a.hint])).toEqual([["Acme", "$48k ARR"], ["Acme Labs", undefined]]);
    expect(found[0].href).toMatch(/^\/accounts\/[0-9a-f-]{36}$/);
  });
});
