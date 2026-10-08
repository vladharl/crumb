"use server";

import { headers } from "next/headers";
import { issueMagicLink, safeNextPath } from "@/lib/auth";
import { originFromHeaders } from "@/lib/origin";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type LoginResult =
  | { ok: true }
  | { ok: false; error: string };

export async function requestMagicLink(formData: FormData): Promise<LoginResult> {
  const raw = formData.get("email");
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";

  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: "Please enter a valid email." };
  }

  const origin = originFromHeaders(headers());
  if (!origin) return { ok: false, error: "Could not determine host." };

  await issueMagicLink(email, origin, safeNextPath(formData.get("next")));
  return { ok: true };
}
