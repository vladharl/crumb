"use server";

import { headers } from "next/headers";
import { issueMagicLink, safeNextPath } from "@/lib/auth";
import { log } from "@/lib/log";
import { originFromHeaders } from "@/lib/origin";
import { callerIpFromHeaders, checkRateLimitAsync } from "@/lib/rate-limit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOUR = 60 * 60;
let warnedNoClientIp = false;

export type LoginResult =
  | { ok: true }
  | { ok: false; error: string };

export async function requestMagicLink(formData: FormData): Promise<LoginResult> {
  const raw = formData.get("email");
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";

  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return { ok: false, error: "Please enter a valid email." };
  }

  const h = headers();
  const origin = originFromHeaders(h);
  if (!origin) return { ok: false, error: "Could not determine host." };

  // Per IP, then per address: nobody floods one inbox (each link also kills
  // the one before it) or sprays links at many. A limited request gets the
  // same answer as a sent link, and both limits run before any account lookup,
  // so neither says whether the address has an account. With no header naming
  // the client ("anon": the app reached directly, no proxy in front), everyone
  // would share one IP bucket and 20 sign-ins an hour would silently lock the
  // whole team out, so only the per-address limit applies.
  const ip = callerIpFromHeaders(h);
  if (ip === "anon" && !warnedNoClientIp) {
    warnedNoClientIp = true;
    log.warn("sign-in requests carry no client IP header (CF-Connecting-IP, X-Real-IP or X-Forwarded-For), so they're limited per address only", { scope: "crumb/login" });
  }
  const limited =
    (ip !== "anon" && !(await checkRateLimitAsync(`login:ip:${ip}`, { capacity: 20, refillPerSec: 20 / HOUR })).ok) ||
    !(await checkRateLimitAsync(`login:to:${email}`, { capacity: 5, refillPerSec: 5 / HOUR })).ok;
  if (limited) return { ok: true };

  await issueMagicLink(email, origin, safeNextPath(formData.get("next")));
  return { ok: true };
}
