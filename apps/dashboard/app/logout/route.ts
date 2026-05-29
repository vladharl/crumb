import { NextResponse } from "next/server";
import { destroySession, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handler(req: Request) {
  await destroySession();
  const res = NextResponse.redirect(new URL("/login", req.url));
  res.cookies.set(SESSION_COOKIE, "", { expires: new Date(0), path: "/" });
  return res;
}

export const GET = handler;
export const POST = handler;
