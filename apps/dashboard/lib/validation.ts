import { z } from "zod";

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
