import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db, accounts, accountUsers, items, workspaces } from "@crumb/db";
import { requireSession } from "@/lib/auth";
import { sign, verify } from "@/lib/jwt";
import { installSnippets } from "@/app/(app)/settings/install/snippets";
import { mintTestToken } from "@/app/(app)/settings/install/actions";
import { TEST_CUSTOMER_ACCOUNT } from "@/app/(app)/settings/install/test-customer";
import { GET as me } from "@/app/api/v1/me/route";
import { loadItems } from "@/app/(app)/inbox/InboxTableTile";

// Settings → Install: snippets carry the canonical origin, "Try it" mints a
// real (short-lived) widget token, and GET /api/v1/me stamps the workspace's
// first widget ping exactly once. Neither it nor the inbox's first-run check
// counts the preview, even once account mapping renames its account.

vi.mock("@/lib/auth", () => ({ requireSession: vi.fn() }));

const SECRET = "s".repeat(64);
const session = (role: string) => ({
  workspace: { slug: "acme", signingSecret: SECRET },
  user: { id: "user-1", role, email: "pat@vendor.test", name: "Pat" },
}) as unknown as Awaited<ReturnType<typeof requireSession>>;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("install snippets", () => {
  it("point at CRUMB_APP_URL, not the request's host", () => {
    vi.stubEnv("CRUMB_APP_URL", "https://crumb.example.com/");
    const s = installSnippets(new Headers({ host: "0.0.0.0:3000" }), "acme");
    expect(s.origin).toBe("https://crumb.example.com");
    expect(s.install).toContain(`<script src="https://crumb.example.com/widget.js"`);
    expect(s.install).toContain(`data-workspace="acme"`);
    for (const code of [s.install, s.dev, s.hidden, ...s.signing.map(x => x.code)]) {
      expect(code).not.toContain("0.0.0.0");
      expect(code).not.toContain("your-crumb-host");
    }
  });

  it("the JavaScript API snippet lists every call a host can make, and the optional tag attributes", () => {
    const { api } = installSnippets(new Headers({ host: "crumb.test" }), "acme");
    for (const call of ["crumb.open(", "crumb.close(", "crumb.toggle(", "crumb.onUnread(", "crumb.identify({ jwt",
      "crumb.shutdown(", "crumb.onTokenExpired(", "crumb.setContext({", "data-app-version=", "data-locale="]) {
      expect(api).toContain(call);
    }
  });
});

describe("Try it test token", () => {
  it("verifies with lib/jwt as the test customer, then expires after 15 minutes", async () => {
    vi.mocked(requireSession).mockResolvedValue(session("pm"));
    const r = await mintTestToken();
    if (!r.ok) throw new Error(r.error);

    const v = verify(r.token, SECRET);
    // Not the teammate's own email, so their real-widget test isn't this account.
    expect(v.ok && v.claims).toMatchObject({ iss: "acme", sub: "preview+user-1@acme.invalid", name: "Pat", account_name: TEST_CUSTOMER_ACCOUNT });

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 14 * 60_000);
    expect(verify(r.token, SECRET).ok).toBe(true);
    vi.setSystemTime(Date.now() + 2 * 60_000); // 16 min in, past the 30s skew
    expect(verify(r.token, SECRET)).toEqual({ ok: false, reason: "expired" });
  });

  it("is admin or pm only", async () => {
    vi.mocked(requireSession).mockResolvedValue(session("viewer"));
    expect(await mintTestToken()).toEqual({ ok: false, error: "forbidden" });
  });
});

// Runs the real route against Postgres (DATABASE_URL, migrated). Skipped
// locally when no database answers; CI has one.
const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

describe.skipIf(!reachable && !process.env.CI)("GET /api/v1/me first ping", () => {
  const tag = randomUUID().slice(0, 8);
  const created: string[] = [];

  afterAll(async () => {
    if (!created.length) return;
    // Items first: their submitter reference blocks the cascade.
    await db.delete(items).where(inArray(items.workspaceId, created));
    await db.delete(workspaces).where(inArray(workspaces.id, created));
  });

  async function workspace() {
    const [ws] = await db.insert(workspaces)
      .values({ slug: `ping-${tag}-${created.length}`, name: "First ping test" })
      .returning({ id: workspaces.id, slug: workspaces.slug, secret: workspaces.signingSecret });
    created.push(ws.id);
    return ws;
  }

  function load(ws: { slug: string; secret: string }, accountName: string, sub = "pat@acme.test") {
    const now = Math.floor(Date.now() / 1000);
    const token = sign({ iss: ws.slug, sub, account_name: accountName, iat: now, exp: now + 600 }, ws.secret);
    return me(new Request("http://localhost/api/v1/me", { headers: { authorization: `Bearer ${token}` } }));
  }

  async function firstPing(id: string) {
    const [row] = await db.select({ at: workspaces.widgetFirstPingAt }).from(workspaces).where(eq(workspaces.id, id));
    return row!.at;
  }

  it("stamps the first widget load once and never writes again", async () => {
    const ws = await workspace();
    const update = vi.spyOn(db, "update");
    try {
      expect((await load(ws, "Acme")).status).toBe(200);
      const at = await firstPing(ws.id);
      expect(at).toBeInstanceOf(Date);
      expect(update).toHaveBeenCalledTimes(1);

      expect((await load(ws, "Acme")).status).toBe(200);
      expect(update).toHaveBeenCalledTimes(1);
      expect(await firstPing(ws.id)).toEqual(at);
    } finally {
      update.mockRestore();
    }
  });

  it("doesn't count the Try-it preview", async () => {
    const ws = await workspace();
    expect((await load(ws, TEST_CUSTOMER_ACCOUNT)).status).toBe(200);
    expect(await firstPing(ws.id)).toBeNull();
  });

  it("knows the preview by its .invalid address after account mapping renames its account", async () => {
    const ws = await workspace();
    const preview = `preview+user-1@${ws.slug}.invalid`; // as mintTestToken signs it
    expect((await load(ws, TEST_CUSTOMER_ACCOUNT, preview)).status).toBe(200);
    await db.update(accounts).set({ name: "Renamed Co" }).where(eq(accounts.workspaceId, ws.id));
    expect((await load(ws, TEST_CUSTOMER_ACCOUNT, preview)).status).toBe(200);
    expect(await firstPing(ws.id)).toBeNull();
  });

  it("marks the preview's inbox items by that address too, but not every .invalid one", async () => {
    const ws = await workspace();
    const [acct] = await db.insert(accounts).values({ workspaceId: ws.id, name: "Renamed Co" }).returning({ id: accounts.id });
    const people = await db.insert(accountUsers).values([
      { workspaceId: ws.id, accountId: acct!.id, email: `preview+user-1@${ws.slug}.invalid`, name: "Pat", initials: "P" },
      // A Slack capture with no address of its own: real feedback.
      { workspaceId: ws.id, accountId: acct!.id, email: "slack-U1@slack.invalid", name: "Sam", initials: "S" },
    ]).returning({ id: accountUsers.id, name: accountUsers.name });
    await db.insert(items).values(people.map((p, i) => ({
      workspaceId: ws.id, accountId: acct!.id, submitterId: p.id, seq: i + 1, shortId: `FB-${i + 1}`,
      title: `From ${p.name}`, type: "idea",
    })));
    const rows = await loadItems(ws.id);
    expect(Object.fromEntries(rows.map(r => [r.submitterName, r.previewSubmitter]))).toEqual({ Pat: true, Sam: false });
  });
});
