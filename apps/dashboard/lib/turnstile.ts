import "server-only";
import { log } from "./log";

// Cloudflare Turnstile server-side verification for the public /signup form.
// Site key (NEXT_PUBLIC_TURNSTILE_SITE_KEY) renders the widget on the client;
// the secret (TURNSTILE_SECRET_KEY) verifies the returned token here.
//
// When TURNSTILE_SECRET_KEY is unset, verification is treated as DISABLED and
// always passes — so local/dev and self-host (where signup isn't even exposed)
// work with zero config. Set both keys in production to actually enforce it.

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function turnstileEnabled(): boolean {
  return !!process.env.TURNSTILE_SECRET_KEY?.trim();
}

export async function verifyTurnstile(token: string | null | undefined, ip?: string | null): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return true; // not configured → not enforced
  if (!token) return false;

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set("remoteip", ip);
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    log.error("turnstile verify failed", { scope: "crumb/turnstile", err });
    return false; // fail closed — a verification outage shouldn't open the gate
  }
}
