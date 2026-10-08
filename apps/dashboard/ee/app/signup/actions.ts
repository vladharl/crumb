"use server";

import { headers } from "next/headers";
import { countRecentSignups, createPendingSignup } from "@crumb/db";
import { isCloud } from "@/lib/tier";
import { originFromHeaders } from "@/lib/origin";
import { ensureUniqueSlug } from "@/lib/provision";
import { verifyTurnstile } from "@/lib/turnstile";
import { sendSignupVerify } from "@/lib/email";
import { callerIpFromHeaders } from "@/lib/rate-limit";
import { log } from "@/lib/log";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SIGNUP_TTL_MIN = 30;

// Per-window abuse caps: generous for legit retries, tight enough to stop a
// single email/IP spraying pending workspaces.
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_EMAIL = 3;
const MAX_PER_IP = 10;

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export type SignupResult = { ok: true } | { ok: false; error: string };

// Self-serve signup (Cloud, free-first). Validates input, checks Turnstile +
// the per-window throttle, then mints an email-verification token carrying the
// pending workspace details and emails the confirm link. The workspace is NOT
// created here — only when the visitor clicks the link (signup/verify).
export async function startSignup(formData: FormData): Promise<SignupResult> {
  if (!isCloud()) return { ok: false, error: "Self-serve signup isn't available on this deployment." };

  const h = headers();
  const workspaceName = String(formData.get("workspaceName") ?? "").trim();
  const adminName     = String(formData.get("adminName") ?? "").trim();
  const adminEmail    = String(formData.get("adminEmail") ?? "").trim().toLowerCase();
  const turnstile     = String(formData.get("cf-turnstile-response") ?? "");

  if (!workspaceName)             return { ok: false, error: "Workspace name is required." };
  if (!adminName)                 return { ok: false, error: "Your name is required." };
  if (!EMAIL_RE.test(adminEmail)) return { ok: false, error: "Enter a valid email." };
  // Affirmative consent: the form gates the button on this, but never trust the
  // client — a forged POST without the checkbox must not create a workspace.
  if (!formData.get("acceptedTerms")) return { ok: false, error: "Please accept the Terms of Service and Privacy Policy." };

  // Not the first X-Forwarded-For entry: behind Cloudflare that's whatever the
  // client sent, so rotating it would dodge the per-IP cap below.
  const caller = callerIpFromHeaders(h);
  const ip = caller === "anon" ? null : caller;

  if (!(await verifyTurnstile(turnstile, ip))) {
    return { ok: false, error: "Couldn't verify you're human. Please try again." };
  }

  // Throttle by email OR IP over the window. Don't reveal which limit tripped.
  const since = new Date(Date.now() - WINDOW_MS);
  const [byEmail, byIp] = await Promise.all([
    countRecentSignups({ email: adminEmail, since }),
    ip ? countRecentSignups({ ip, since }) : Promise.resolve(0),
  ]);
  if (byEmail >= MAX_PER_EMAIL || byIp >= MAX_PER_IP) {
    return { ok: false, error: "Too many signup attempts. Please try again later." };
  }

  const origin = originFromHeaders(h);
  if (!origin) return { ok: false, error: "Could not determine host." };

  const slug = await ensureUniqueSlug(slugify(workspaceName));
  const token = await createPendingSignup({ workspaceName, slug, adminName, adminEmail, ip });
  const link = `${origin}/signup/verify?token=${encodeURIComponent(token)}`;

  try {
    await sendSignupVerify({ to: adminEmail, link, ttlMinutes: SIGNUP_TTL_MIN, workspaceName });
  } catch (err) {
    // The pending row exists; the user can retry. Don't surface send internals.
    log.error("signup verify send threw", { scope: "crumb/signup", err });
  }

  return { ok: true };
}
