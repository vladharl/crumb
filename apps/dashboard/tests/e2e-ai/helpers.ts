import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";

// Mint a widget identity JWT (HS256) against the seeded workspace signing
// secret, so AI specs can submit items through the public capture path at cloud
// tier (which fires auto-triage + embeddings). Mirrors lib/jwt.sign.

function b64u(s: string | Buffer): string {
  const b = typeof s === "string" ? Buffer.from(s, "utf8") : s;
  return b.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signingSecret(): string {
  const ctx = JSON.parse(readFileSync(resolve(__dirname, ".auth/ctx.json"), "utf8")) as { signingSecret: string };
  return ctx.signingSecret;
}

export function mintWidgetJwt(opts: { email: string; accountName: string; name?: string; role?: "admin" | "member" }): string {
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64u(JSON.stringify({
    iss: "southbeam",
    sub: opts.email,
    account_name: opts.accountName,
    name: opts.name,
    role: opts.role ?? "admin",
    iat: now,
    exp: now + 3600,
  }));
  const sig = b64u(createHmac("sha256", signingSecret()).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

// Submit an item via POST /api/v1/items with a minted JWT. Returns the short id.
export async function submitWidgetItem(
  request: APIRequestContext,
  opts: { email: string; accountName: string; type: string; title: string; body?: string; name?: string },
): Promise<string> {
  const jwt = mintWidgetJwt({ email: opts.email, accountName: opts.accountName, name: opts.name, role: "admin" });
  const resp = await request.post("/api/v1/items", {
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    data: { type: opts.type, title: opts.title, body: opts.body ?? "" },
  });
  if (!resp.ok()) throw new Error(`submit failed ${resp.status()}: ${await resp.text()}`);
  const json = await resp.json();
  return json.short_id as string;
}
