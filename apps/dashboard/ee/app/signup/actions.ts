"use server";

import { headers } from "next/headers";
import { countRecentSignups, createPendingSignup } from "@crumb/db";
import { isCloud } from "@/lib/tier";
import { originFromHeaders } from "@/lib/origin";
import { ensureUniqueSlug } from "@/lib/provision";
import { verifyTurnstile } from "@/lib/turnstile";
import { sendSignupVerify } from "@/lib/email";
import { callerIpFromHeaders, checkRateLimitAsync } from "@/lib/rate-limit";
import { log } from "@/lib/log";
import { billingParams, findOpenPendingSignup } from "./pending";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SIGNUP_TTL_MIN = 30;
// A resend reuses a link that still has this long to live; past that it mints a
// fresh one, so the email never lands with a minute left on the clock.
const REUSE_MIN = 10;

// Per-window abuse caps: generous for legit retries, tight enough to stop a
// single email/IP spraying pending workspaces.
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_EMAIL = 3;
const MAX_PER_IP = 10;

function slugify(name: string): string {
  // Trim hyphens after the cut too, so a long name can't end in "-".
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
}

export type SignupResult = { ok: true } | { ok: false; error: string };

// Self-serve signup (Cloud, free-first). Validates input, checks Turnstile +
// the per-window throttle, then mints an email-verification token carrying the
// pending workspace details and emails the confirm link. The workspace is NOT
// created here — only when the visitor confirms from the link (signup/verify).
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
  const billing = billingParams(formData.get("plan"), formData.get("interval"));
  return sendLink(origin, token, { to: adminEmail, workspaceName, ttlMinutes: SIGNUP_TTL_MIN }, billing);
}

// "Resend the link" after signing up, and "Send a new link" from an expired
// one: the same pending signup, found by its email + workspace name. No
// Turnstile, since it only ever mails an address that passed it at signup, and
// each address gets the same hourly cap as signing up.
export async function resendSignup(input: {
  workspaceName: string;
  adminEmail: string;
  plan?: string;
  interval?: string;
}): Promise<SignupResult> {
  if (!isCloud()) return { ok: false, error: "Self-serve signup isn't available on this deployment." };

  const workspaceName = String(input?.workspaceName ?? "").trim();
  const adminEmail = String(input?.adminEmail ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(adminEmail)) return { ok: false, error: "Enter a valid email." };

  const limit = await checkRateLimitAsync(`signup-resend:${adminEmail}`, {
    capacity: MAX_PER_EMAIL,
    refillPerSec: MAX_PER_EMAIL / (WINDOW_MS / 1000),
  });
  if (!limit.ok) {
    return { ok: false, error: "We've sent a few links already. Check your spam folder, or try again in a little while." };
  }

  const pending = await findOpenPendingSignup({ email: adminEmail, workspaceName });
  if (!pending) {
    return { ok: false, error: "We couldn't find that signup. If you already confirmed it, sign in. If not, fill in the form again." };
  }

  const origin = originFromHeaders(headers());
  if (!origin) return { ok: false, error: "Could not determine host." };

  // Same link while it still has time on it. Otherwise a fresh token: an
  // expired one is never revived, so a stale link stays dead wherever it ended up.
  const minutesLeft = Math.floor((pending.expiresAt.getTime() - Date.now()) / 60_000);
  const reuse = minutesLeft >= REUSE_MIN;
  const token = reuse ? pending.token : await createPendingSignup({
    workspaceName: pending.workspaceName,
    slug: pending.slug,
    adminName: pending.adminName,
    adminEmail: pending.adminEmail,
    ip: pending.ip,
  });
  return sendLink(
    origin,
    token,
    { to: pending.adminEmail, workspaceName: pending.workspaceName, ttlMinutes: reuse ? minutesLeft : SIGNUP_TTL_MIN },
    billingParams(input?.plan, input?.interval),
  );
}

async function sendLink(
  origin: string,
  token: string,
  mail: { to: string; workspaceName: string; ttlMinutes: number },
  billing: Record<string, string>,
): Promise<SignupResult> {
  // Lands on /signup, which shows a Create button. Only that button's POST
  // spends the token, so a mail scanner opening the link changes nothing.
  const link = `${origin}/signup?${new URLSearchParams({ token, ...billing })}`;
  // A refused send (bad address, unverified domain, rate limit) or a thrown one
  // both land on the same error, never on "Check your email".
  try {
    if (await sendSignupVerify({ ...mail, link })) return { ok: true };
  } catch (err) {
    log.error("signup verify send threw", { scope: "crumb/signup", err });
  }
  return { ok: false, error: `We couldn't send the email to ${mail.to}. Check the address, or try again in a minute.` };
}
