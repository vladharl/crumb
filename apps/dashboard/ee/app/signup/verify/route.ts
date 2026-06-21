import { NextResponse } from "next/server";
import { findValidPendingSignup, consumePendingSignup } from "@crumb/db";
import { SESSION_COOKIE, createSession } from "@/lib/auth";
import { createWorkspaceWithAdmin, ensureUniqueSlug } from "@/lib/provision";
import { originFromHeaders } from "@/lib/origin";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /signup/verify?token=… — consumes a pending self-serve signup: creates
// the workspace + first admin, signs them in, and redirects to /inbox. Mirrors
// the magic-link verify route's cookie/redirect handling.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  // Build redirects against the public origin (CRUMB_APP_URL), not req.url —
  // behind a tunnel req.url is the internal service address.
  const base = originFromHeaders(req.headers) ?? req.url;

  const pending = await findValidPendingSignup(token);
  if (!pending) {
    const back = new URL("/signup", base);
    back.searchParams.set("e", "expired");
    return NextResponse.redirect(back);
  }

  try {
    // Re-resolve the slug at consume time — another signup may have taken the
    // derived slug between request and verification.
    const slug = await ensureUniqueSlug(pending.slug);
    const created = await createWorkspaceWithAdmin({
      name: pending.workspaceName,
      slug,
      adminName: pending.adminName,
      adminEmail: pending.adminEmail,
    });
    if (!created) throw new Error("provision returned null");

    // Burn the token now that the workspace exists — single-use.
    await consumePendingSignup(pending.id);

    const { cookieValue, expiresAt } = await createSession(created.workspace.id, created.user.id);
    const res = NextResponse.redirect(new URL("/inbox", base));
    res.cookies.set(SESSION_COOKIE, cookieValue, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      expires: expiresAt,
      path: "/",
    });
    return res;
  } catch (err) {
    log.error("signup verify provisioning failed", { scope: "crumb/signup", err });
    const back = new URL("/signup", base);
    back.searchParams.set("e", "failed");
    return NextResponse.redirect(back);
  }
}
