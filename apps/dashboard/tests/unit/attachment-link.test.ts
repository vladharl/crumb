import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, accounts, accountUsers, attachments, items, replies, workspaces } from "@crumb/db";
import { sign } from "@/lib/jwt";
import { ATTACHMENT_LINK_TTL_SECONDS, signedAttachmentPath } from "@/lib/attachments/signed-url";
import { GET as threadGet } from "@/app/api/v1/items/[shortId]/route";
import { GET as uploadGet } from "@/app/api/v1/uploads/[id]/route";

// The widget opens attachments with <a target="_blank">, which can't send the
// customer's JWT, so every widget attachment link 403'd. The thread payload
// now hands out short-lived signed links; one must open exactly its own
// attachment, with no credentials, until it expires.
//
// Runs the real route handlers against Postgres (DATABASE_URL, migrated via
// `pnpm db:migrate`). Skipped locally when no database answers; CI has one,
// so there it fails instead of skipping.

// No request scope for cookies() outside Next, and the bytes don't matter.
vi.mock("@/lib/auth", () => ({ getSession: async () => null }));
vi.mock("@/lib/storage", () => ({ getBytes: async () => Buffer.from("file-bytes") }));

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);
const tag = randomUUID().slice(0, 8);
let wsId: string | null = null;

describe.skipIf(!reachable && !process.env.CI)("widget attachment links", () => {
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!wsId) return;
    await db.delete(items).where(eq(items.workspaceId, wsId));
    await db.delete(workspaces).where(eq(workspaces.id, wsId));
  });

  it("the thread payload's signed link opens that attachment and nothing else, until it expires", async () => {
    vi.stubEnv("CRUMB_APP_URL", "https://crumb.test");
    const [ws] = await db.insert(workspaces).values({ slug: `att-link-${tag}`, name: "Attachment links" })
      .returning({ id: workspaces.id, slug: workspaces.slug, secret: workspaces.signingSecret });
    wsId = ws.id;
    const [acct] = await db.insert(accounts).values({ workspaceId: ws.id, name: "Acme" }).returning({ id: accounts.id });
    const [pat] = await db.insert(accountUsers)
      .values({ workspaceId: ws.id, accountId: acct.id, email: "pat@acme.test", name: "Pat", initials: "P" })
      .returning({ id: accountUsers.id });
    const [item] = await db.insert(items)
      .values({ workspaceId: ws.id, accountId: acct.id, submitterId: pat.id, seq: 1, shortId: "FB-1", title: "Export breaks", type: "bug" })
      .returning({ id: items.id });
    const [reply] = await db.insert(replies).values({ itemId: item.id, accountUserId: pat.id, body: "screenshots" }).returning({ id: replies.id });
    const [a, b] = await db.insert(attachments).values([
      { replyId: reply.id, filename: "a.png", contentType: "image/png", sizeBytes: 10, storageKey: `test/${tag}/a` },
      { replyId: reply.id, filename: "b.png", contentType: "image/png", sizeBytes: 10, storageKey: `test/${tag}/b` },
    ]).returning({ id: attachments.id });

    const jwt = sign({ iss: ws.slug, sub: "pat@acme.test", account_name: "Acme", exp: Math.floor(Date.now() / 1000) + 300 }, ws.secret);
    const thread = await threadGet(
      new Request("http://localhost/api/v1/items/FB-1", { headers: { authorization: `Bearer ${jwt}` } }),
      { params: { shortId: "FB-1" } },
    );
    expect(thread.status).toBe(200);
    const body = await thread.json();
    const url: string = body.messages[0].attachments.find((x: { id: string }) => x.id === a.id).url;
    expect(url).toMatch(new RegExp(`^https://crumb\\.test/api/v1/uploads/${a.id}\\?exp=\\d+&sig=[\\w-]+$`));
    expect(url).not.toContain(jwt);

    const open = (id: string, query: string) =>
      uploadGet(new Request(`http://localhost/api/v1/uploads/${id}${query}`), { params: { id } });
    const query = new URL(url).search;

    const res = await open(a.id, query);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("file-bytes");

    expect((await open(b.id, query)).status).toBe(403); // a's signature, b's id

    const sig = new URL(url).searchParams.get("sig")!;
    expect((await open(a.id, query.replace(sig, (sig[0] === "A" ? "B" : "A") + sig.slice(1)))).status).toBe(403);

    const expired = signedAttachmentPath(a.id, ws.secret, Date.now() - 2 * ATTACHMENT_LINK_TTL_SECONDS * 1000);
    expect((await open(a.id, expired.slice(expired.indexOf("?")))).status).toBe(403);

    // The link is customer-facing and the uploader picks the Content-Type: an
    // SVG or HTML file must download sandboxed, never render on this origin.
    expect(res.headers.get("content-disposition")).toBe('inline; filename="a.png"');
    const [svg] = await db.insert(attachments)
      .values({ replyId: reply.id, filename: "x.svg", contentType: "image/svg+xml", sizeBytes: 10, storageKey: `test/${tag}/x` })
      .returning({ id: attachments.id });
    const svgPath = signedAttachmentPath(svg.id, ws.secret);
    const svgRes = await open(svg.id, svgPath.slice(svgPath.indexOf("?")));
    expect(svgRes.status).toBe(200);
    expect(svgRes.headers.get("content-disposition")).toBe('attachment; filename="x.svg"');
    expect(svgRes.headers.get("content-security-policy")).toBe("sandbox");
  });
});
