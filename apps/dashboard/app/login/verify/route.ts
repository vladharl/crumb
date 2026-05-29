import { NextResponse } from "next/server";
import { consumeMagicToken, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";

  const result = await consumeMagicToken(token);
  if (!result.ok) {
    const back = new URL("/login", req.url);
    back.searchParams.set("e", result.error);
    return NextResponse.redirect(back);
  }

  const res = NextResponse.redirect(new URL("/inbox", req.url));
  res.cookies.set(SESSION_COOKIE, result.cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: result.expiresAt,
    path: "/",
  });
  return res;
}
