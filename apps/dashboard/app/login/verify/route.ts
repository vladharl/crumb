import { NextResponse } from "next/server";
import { consumeMagicToken, safeNextPath, SESSION_COOKIE } from "@/lib/auth";
import { originFromHeaders } from "@/lib/origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Build redirects against the public origin (CRUMB_APP_URL), not req.url —
// behind a tunnel req.url is the internal service address (0.0.0.0:3000).
const publicBase = (req: Request) => originFromHeaders(req.headers) ?? req.url;

// A GET never signs anyone in. Mail scanners open every link in an email, and
// when this spent the token they burned it before the person clicked ("That
// link was already used"). It forwards to the Continue page, whose button
// POSTs back here.
export function GET(req: Request) {
  const page = new URL("/login/continue", publicBase(req));
  page.search = new URL(req.url).search; // token + next
  return NextResponse.redirect(page);
}

export async function POST(req: Request) {
  const base = publicBase(req);
  const form = await req.formData().catch(() => null);
  const next = safeNextPath(form?.get("next"));
  // Only our own Continue button spends a token: a form on another site, or on
  // a sibling subdomain, posting someone else's would sign the visitor into
  // that account (same check as signup/verify).
  const site = req.headers.get("sec-fetch-site");
  const token = site === "cross-site" || site === "same-site" ? "" : String(form?.get("token") ?? "");

  // 303s, so the browser follows with a GET.
  const result = await consumeMagicToken(token);
  if (!result.ok) {
    const back = new URL("/login", base);
    back.searchParams.set("e", result.error);
    if (next) back.searchParams.set("next", next);
    return NextResponse.redirect(back, 303);
  }

  const res = NextResponse.redirect(new URL(next ?? "/inbox", base), 303);
  res.cookies.set(SESSION_COOKIE, result.cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: result.expiresAt,
    path: "/",
  });
  return res;
}
