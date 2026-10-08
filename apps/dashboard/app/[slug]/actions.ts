"use server";

import { headers } from "next/headers";
import { originFromHeaders } from "@/lib/origin";
import { requestPublicFollow } from "@/lib/public-follows";
import { callerIpFromHeaders } from "@/lib/rate-limit";

export type FollowState = { ok: boolean; message: string } | null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The public pages' Follow and "Email me updates" forms. Any valid address
// gets the same answer, whether it's new, already following or rate limited,
// and the work runs after the reply so the timing doesn't tell either.
export async function followPublic(_prev: FollowState, form: FormData): Promise<FollowState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, message: "Enter a valid email address." };
  const h = headers();
  void requestPublicFollow({
    slug: String(form.get("slug") ?? ""),
    initiativeId: String(form.get("initiative") ?? "") || null,
    email,
    ip: callerIpFromHeaders(h),
    origin: originFromHeaders(h),
  });
  return { ok: true, message: "Check your inbox to confirm." };
}
