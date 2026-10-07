import { z } from "zod";
import type { ItemContext } from "@crumb/db";

// Shared request-validation schemas for the public API (/api/v1/*). Zod
// gives us length caps + shape checks in one place, so a hostile or buggy
// client can't push unbounded text into the database or trip downstream
// code with the wrong types. Error messages are the stable string codes the
// widget already keys on ("missing_title", "invalid_type", …).
//
// These are the app-layer control. A defense-in-depth mirror as Postgres
// CHECK constraints (char_length caps on items.title/body, replies.body) is
// a follow-up — see the launch plan.

// Field length caps. Generous enough for real feedback, tight enough to
// bound storage and rendering cost.
export const LIMITS = {
  title: 300,
  body: 20_000,
  reply: 20_000,
  name: 200,
  email: 320, // RFC 5321 max
  slug: 64,
} as const;

// Optional free-text identity field: trimmed, length-capped, dropped if empty.
const optName = z.string().trim().max(LIMITS.name).optional();
const optSlug = z.string().trim().min(1).max(LIMITS.slug).optional();
// Loose email: length-capped + must look like an address. Identity is
// ultimately resolved/authorized in resolveCustomer; this just bounds it.
const optEmail = z.string().trim().max(LIMITS.email).regex(/.+@.+/, "invalid_email").optional();

// ── Submission context (where the widget was when the customer wrote in) ──
// Best-effort metadata, so it never costs the customer their feedback: text is
// trimmed and truncated rather than rejected, a malformed field is dropped,
// and a context that isn't an object is ignored. URLs render as links in the
// dashboard, so only http(s) is kept, without user:pass@ or secret-looking
// query/fragment values.
export const CONTEXT_LIMITS = { url: 2_048, title: 300, userAgent: 512, locale: 35, appVersion: 64 } as const;

// The names the widget and its recorder redact before sending
// (apps/widget/src/redact.ts; a unit test holds the two together). Matched
// lowercased with separators stripped, so access_token, accessToken and
// X-Api-Key all hit.
// ponytail: errs toward redacting (author, zipcode); an innocently named secret still lands.
const SECRET_PARAM = /pass|pwd|secret|token|auth|key$|code$|credential|signature|session|cookie|jwt|csrf|xsrf|otp|verifier|cvv|cvc|ssn|cardnumber|^(sig|sid|pin)$/;

function isSecretParam(k: string): boolean {
  let name = k;
  try { name = decodeURIComponent(k.replace(/\+/g, " ")); } catch { /* malformed escape: match it raw */ }
  return SECRET_PARAM.test(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

// http(s) only, capped, without user:pass@ and with secret-looking key=value
// pairs (query, fragment, ;matrix) redacted. Truncating first is safe: any
// value that survives the cut still has its whole key in front of it.
export function redactContextUrl(raw: string): string | undefined {
  const s = raw.trim().slice(0, CONTEXT_LIMITS.url);
  if (!/^https?:\/\/\S/i.test(s)) return undefined;
  return s
    .replace(/^(https?:\/\/)[^/?#@]*@/i, "$1")
    .replace(/(^|[?#&;])([^=&#;?]*)=([^&#;?]*)/g, (m, sep: string, k: string) => (isSecretParam(k) ? `${sep}${k}=[redacted]` : m));
}

const ctxText = (max: number) =>
  z.string().transform(s => s.trim().slice(0, max) || undefined).optional().catch(undefined);
const ctxUrl = z.string().transform(redactContextUrl).optional().catch(undefined);
const ctxPx = z.number().min(0).max(100_000).transform(Math.round);

export const submissionContextSchema = z
  .object({
    page_url: ctxUrl,
    page_title: ctxText(CONTEXT_LIMITS.title),
    referrer: ctxUrl,
    user_agent: ctxText(CONTEXT_LIMITS.userAgent),
    viewport: z.object({ w: ctxPx, h: ctxPx }).strip().optional().catch(undefined),
    locale: ctxText(CONTEXT_LIMITS.locale),
    app_version: ctxText(CONTEXT_LIMITS.appVersion),
  })
  .strip()
  // Dropped fields come back as undefined keys: keep what survived, or nothing.
  .transform(c => {
    const kept = Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined));
    return Object.keys(kept).length ? (kept as ItemContext) : undefined;
  })
  .optional()
  .catch(undefined);

export const createItemSchema = z
  .object({
    workspace_slug: optSlug,
    account_user_email: optEmail,
    account_user_name: optName,
    account_name: optName,
    type: z.enum(["bug", "idea", "question"], { message: "invalid_type" }),
    title: z.string().trim().min(1, "missing_title").max(LIMITS.title, "title_too_long"),
    body: z.string().max(LIMITS.body, "body_too_long").optional(),
    session_token: z.string().regex(/^[0-9a-f]{32}$/, "invalid_session_token").optional(),
    context: submissionContextSchema,
    // Files from the compose form, linked to the first message. Upload ids are
    // uuids; checked here so a bad one fails before the item exists, not after.
    attachment_ids: z.array(z.string().uuid("invalid_attachment_id")).max(50).optional(),
  })
  .strip();

export type CreateItemInput = z.infer<typeof createItemSchema>;

export const createReplySchema = z
  .object({
    workspace_slug: optSlug,
    account_user_email: optEmail,
    body: z.string().max(LIMITS.reply, "body_too_long").optional(),
    attachment_ids: z.array(z.string().min(1).max(128)).max(50).optional(),
  })
  .strip();

export type CreateReplyInput = z.infer<typeof createReplySchema>;

// Customer closes ("resolves") their own request from the widget. Identity is
// resolved/authorized in resolveCustomer (JWT, or workspace_slug + email on
// self-host); the optional reason is a short free-text note for the timeline.
export const closeItemSchema = z
  .object({
    workspace_slug: optSlug,
    account_user_email: optEmail,
    reason: z.string().trim().max(LIMITS.reply, "reason_too_long").optional(),
  })
  .strip();

export type CloseItemInput = z.infer<typeof closeItemSchema>;

// Usage-event ingestion (crumb.track). A batch of named events with bounded
// props — caps mirror the widget's client-side batching so a hostile or chatty
// client can't push unbounded JSON. props is capped by serialized size after
// parse (see USAGE_PROPS_MAX_BYTES below) since zod can't weigh bytes cheaply.
export const USAGE_EVENTS_PER_BATCH = 50;
export const USAGE_PROPS_MAX_BYTES = 4_096;
export const USAGE_PROPS_MAX_KEYS = 30;

const usageEventSchema = z.object({
  name: z.string().trim().min(1, "missing_event_name").max(64, "event_name_too_long"),
  props: z.record(z.string(), z.unknown()).optional(),
  ts: z.string().datetime({ offset: true }).optional(),
  // Capped and redacted like a submission's page (an OAuth ?code= must not land).
  page_url: ctxUrl,
});

export const createUsageEventsSchema = z
  .object({
    workspace_slug: optSlug,
    account_user_email: optEmail,
    account_user_name: optName,
    account_name: optName,
    session_token: z.string().regex(/^[0-9a-f]{32}$/, "invalid_session_token").optional(),
    events: z.array(usageEventSchema).min(1, "no_events").max(USAGE_EVENTS_PER_BATCH, "too_many_events"),
  })
  .strip();

export type CreateUsageEventsInput = z.infer<typeof createUsageEventsSchema>;

// Bound a single event's props to a key count + serialized byte budget.
// Returns a sanitized object (empty when over budget or not a plain object) —
// belt-and-suspenders alongside the client-side cap.
export function sanitizeEventProps(props: unknown): Record<string, unknown> {
  if (!props || typeof props !== "object" || Array.isArray(props)) return {};
  const entries = Object.entries(props as Record<string, unknown>).slice(0, USAGE_PROPS_MAX_KEYS);
  const obj = Object.fromEntries(entries);
  try {
    if (Buffer.byteLength(JSON.stringify(obj), "utf8") > USAGE_PROPS_MAX_BYTES) return {};
  } catch {
    return {};
  }
  return obj;
}

export type ParseResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

// Parse a JSON request body against a schema. Returns the stable error code
// (the schema's first issue message) so callers can `return fail(status, error)`.
export async function parseJsonBody<T>(req: Request, schema: z.ZodType<T>): Promise<ParseResult<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }
  const res = schema.safeParse(raw);
  if (!res.success) {
    const first = res.error.issues[0];
    return { ok: false, status: 400, error: first?.message || "invalid_input" };
  }
  return { ok: true, data: res.data };
}
