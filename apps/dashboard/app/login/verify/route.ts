import { NextResponse } from "next/server";
import { consumeMagicToken, SESSION_COOKIE } from "@/lib/auth";
import { originFromHeaders } from "@/lib/origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  // Build redirects against the public origin (CRUMB_APP_URL), not req.url —
  // behind a tunnel req.url is the internal service address (0.0.0.0:3000).
  const base = originFromHeaders(req.headers) ?? req.url;

  const result = await consumeMagicToken(token);
  if (!result.ok) {
    const back = new URL("/login", base);
    back.searchParams.set("e", result.error);
    return NextResponse.redirect(back);
  }

  const res = NextResponse.redirect(new URL("/inbox", base));
  res.cookies.set(SESSION_COOKIE, result.cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: result.expiresAt,
    path: "/",
  });
  return res;
}
