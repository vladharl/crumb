"use server";

import { headers } from "next/headers";
import { issueMagicLink } from "@/lib/auth";

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

  const h = headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  if (!host) return { ok: false, error: "Could not determine host." };
  const origin = `${proto}://${host}`;

  await issueMagicLink(email, origin);
  return { ok: true };
}
