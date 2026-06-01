import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

// Slack request signature verification (slash commands + interactivity). Slack
// signs the RAW request body — callers must pass `await req.text()`, not a
// parsed body. Enforces the 5-minute replay window. Unit-tested with a golden.
// Docs: https://api.slack.com/authentication/verifying-requests-from-slack

export function slackSigningSecret(): string {
  return process.env.SLACK_SIGNING_SECRET?.trim() || "";
}

export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  opts?: { secret?: string; nowSec?: number },
): boolean {
  const secret = opts?.secret ?? slackSigningSecret();
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = opts?.nowSec ?? Date.now() / 1000;
  if (Math.abs(now - ts) > 300) return false; // 5-minute window

  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
