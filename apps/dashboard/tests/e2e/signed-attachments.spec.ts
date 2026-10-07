import { test, expect } from "@playwright/test";
import { mintWidgetJwt, publicOrigin, signAttachmentPath } from "./helpers/mint";

// Widget attachments open through short-lived signed links: the customer thread
// payload hands out /api/v1/uploads/<id>?exp&sig (lib/attachments/signed-url.ts),
// because a new tab can't carry the widget JWT. A real identified customer (a
// minted widget JWT) files an item, uploads two files and attaches them to a
// message; each link then opens with no cookie and no Authorization, and only
// for its own attachment until it expires.

test.use({ storageState: { cookies: [], origins: [] } }); // customer side: no dashboard session

const SLUG = "southbeam";

test("attachment links open signed-only, for their own file, until they expire", async ({ request, baseURL }) => {
  const tag = Date.now();
  const auth = {
    authorization: `Bearer ${mintWidgetJwt(SLUG, { sub: `attach+${tag}@example.com`, name: "Attach Tester", account_name: "E2E Attach Co" })}`,
  };

  const item = await request.post("/api/v1/items", {
    headers: auth,
    data: { type: "bug", title: `Signed attachments ${tag}`, body: "Files to follow." },
  });
  expect(item.status()).toBe(201);
  const shortId = (await item.json()).short_id as string;

  const bytes = new Map<string, Buffer>();
  for (const n of [1, 2]) {
    const buffer = Buffer.from(`file ${n} for ${tag}\n`);
    const up = await request.post("/api/v1/uploads", {
      headers: auth,
      multipart: { file: { name: `note-${n}.txt`, mimeType: "text/plain", buffer } },
    });
    expect(up.status()).toBe(201);
    bytes.set((await up.json()).id, buffer);
  }
  const [a, b] = [...bytes.keys()];
  const reply = await request.post(`/api/v1/items/${shortId}`, {
    headers: auth,
    data: { body: "Two files attached.", attachment_ids: [a, b] },
  });
  expect(reply.status()).toBe(201);

  const thread = await request.get(`/api/v1/items/${shortId}`, { headers: auth });
  expect(thread.ok()).toBeTruthy();
  const messages = (await thread.json()).messages as Array<{ attachments: Array<{ id: string; url: string }> }>;
  const links = messages.flatMap((m) => m.attachments);
  expect(links.map((l) => l.id).sort()).toEqual([a, b].sort());

  const now = Math.floor(Date.now() / 1000);
  const signed = new Map<string, URL>();
  for (const l of links) {
    const url = new URL(l.url);
    expect(url.origin).toBe(publicOrigin(new URL(baseURL!).origin));
    expect(url.pathname).toBe(`/api/v1/uploads/${l.id}`);
    const exp = Number(url.searchParams.get("exp"));
    expect(exp).toBeGreaterThan(now);
    expect(exp).toBeLessThanOrEqual(now + 3600 + 5);
    expect(url.searchParams.get("sig")).toMatch(/^[\w-]{22}$/);
    signed.set(l.id, url);

    // Fetched on this server: the link's origin is the public one, another
    // host when .env.local points CRUMB_APP_URL at a tunnel. This spec's
    // request context has no cookies, and no Authorization is sent.
    const res = await request.get(url.pathname + url.search);
    expect(res.status()).toBe(200);
    expect(await res.body()).toEqual(bytes.get(l.id));
  }

  const linkA = signed.get(a)!;
  const exp = linkA.searchParams.get("exp")!;
  const sig = linkA.searchParams.get("sig")!;

  // Tampered signature. The first base64url char holds six whole bits; the
  // last one partly holds padding, so changing it may decode to the same MAC.
  const tampered = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  expect((await request.get(`/api/v1/uploads/${a}?exp=${exp}&sig=${tampered}`)).status()).toBe(403);

  // Correctly signed but expired. The fresh link minted the same way opens,
  // so the expired one fails on its expiry, not on the signing.
  expect((await request.get(signAttachmentPath(SLUG, a, now - 60))).status()).toBe(403);
  expect((await request.get(signAttachmentPath(SLUG, a, now + 600))).status()).toBe(200);

  // A's valid signature on B's id (B's own link opened above).
  expect((await request.get(`/api/v1/uploads/${b}?exp=${exp}&sig=${sig}`)).status()).toBe(403);
});
