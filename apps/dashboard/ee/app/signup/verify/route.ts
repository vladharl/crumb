import { NextResponse } from "next/server";
import { SESSION_COOKIE, createSession } from "@/lib/auth";
import { createWorkspaceWithAdmin, ensureUniqueSlug } from "@/lib/provision";
import { originFromHeaders } from "@/lib/origin";
import { sendSignupNotification } from "@/lib/email";
import { log } from "@/lib/log";
import { billingParams, claimPendingSignup, releasePendingSignup } from "../pending";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /signup/verify?token=… is the link older confirmation emails carry. It
// never consumes anything (mail scanners open links): it forwards to
// /signup?token=…, whose Create button POSTs back here.
export async function GET(req: Request) {
  const to = new URL("/signup", originFromHeaders(req.headers) ?? req.url);
  to.search = new URL(req.url).search;
  return NextResponse.redirect(to, 303);
}

// POST /signup/verify (token, optional plan + interval) — the Create button.
// Burns the token, creates the workspace + first admin, signs them in, and
// lands them on billing (when they came from a pricing CTA) or the inbox.
// Mirrors the magic-link verify route's cookie handling; 303s so the browser
// follows with a GET.
export async function POST(req: Request) {
  // Build redirects against the public origin (CRUMB_APP_URL), not req.url —
  // behind a tunnel req.url is the internal service address.
  const base = originFromHeaders(req.headers) ?? req.url;
  const form = await req.formData().catch(() => new FormData());
  const token = String(form.get("token") ?? "");
  const billing = billingParams(form.get("plan"), form.get("interval"));
  const backToSignup = (e?: string) => {
    const to = new URL("/signup", base);
    to.search = new URLSearchParams({ ...(e ? { e } : {}), token, ...billing }).toString();
    return NextResponse.redirect(to, 303);
  };

  // Only our own page posts here: a cross-site form must not sign a visitor
  // into a workspace someone else just confirmed (login CSRF).
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return backToSignup();

  // Used, expired or bogus: /signup says which and offers a fresh link.
  const pending = await claimPendingSignup(token);
  if (!pending) return backToSignup();

  let created: Awaited<ReturnType<typeof createWorkspaceWithAdmin>> = null;
  try {
    created = await createWorkspaceWithAdmin({
      name: pending.workspaceName,
      // Re-resolve the slug at consume time; another signup may have taken it.
      slug: await ensureUniqueSlug(pending.slug),
      adminName: pending.adminName,
      adminEmail: pending.adminEmail,
    });
  } catch (err) {
    log.error("signup verify provisioning failed", { scope: "crumb/signup", err });
  }
  if (!created) {
    // Nothing was created, so hand the link back: the same button can retry.
    await releasePendingSignup(pending.id);
    return backToSignup("failed");
  }

  // Notify the operator that a new workspace signed up. Opt-in via
  // CRUMB_OPS_EMAIL; best-effort so a send failure never breaks signup.
  const opsEmail = process.env.CRUMB_OPS_EMAIL?.trim();
  if (opsEmail) {
    try {
      await sendSignupNotification({
        to: opsEmail,
        workspaceName: pending.workspaceName,
        adminName: pending.adminName,
        adminEmail: pending.adminEmail,
        slug: created.workspace.slug,
        dashboardUrl: base,
      });
    } catch (err) {
      log.error("signup ops-notification send threw", { scope: "crumb/signup", err });
    }
  }

  const { cookieValue, expiresAt } = await createSession(created.workspace.id, created.user.id);
  const dest = billing.plan ? `/settings/billing?${new URLSearchParams(billing)}` : "/inbox";
  const res = NextResponse.redirect(new URL(dest, base), 303);
  res.cookies.set(SESSION_COOKIE, cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
  return res;
}
