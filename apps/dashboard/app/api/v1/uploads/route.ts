import { NextResponse } from "next/server";
import { db, attachments } from "@crumb/db";
import { cors, fail, preflight, resolveCustomer } from "@/lib/public-api";
import { getSession } from "@/lib/auth";
import { newStorageKey, putBytes } from "@/lib/storage";
import { callerIpFromRequest, checkRateLimitAsync, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function OPTIONS() {
  return preflight();
}

const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_PREFIXES = [
  "image/",
  "application/pdf",
  "application/json",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.",
  "application/msword",
  "application/vnd.ms-excel",
  "text/",
];

function contentTypeAllowed(ct: string): boolean {
  const lower = ct.toLowerCase();
  return ALLOWED_PREFIXES.some(p => lower.startsWith(p));
}

// ─── POST /api/v1/uploads ──────────────────────────────────────
// Multipart upload (single `file` field). Auth: vendor session OR
// customer JWT/email fallback. Returns the new attachment row so the
// client can include its id in the next reply submission.
export async function POST(req: Request) {
  // Tighter limit for uploads — files cost storage + bandwidth.
  const rl = await checkRateLimitAsync(`uploads:${callerIpFromRequest(req)}`, { capacity: 20, refillPerSec: 0.33 });
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  // Parse the multipart body exactly once. Reading the request body twice
  // (a clone() peek for the customer fields, then again here) could drop the
  // upstream connection mid-upload and surface as a 502 from the proxy, so we
  // parse up front and reuse the parsed form for both auth and the file.
  const form = await req.formData().catch(() => null);
  if (!form) return fail(400, "bad_multipart");

  // Vendor side first — preferred when a dashboard cookie is present.
  const session = await getSession();
  let uploaderWorkspaceUserId: string | null = null;
  let uploaderAccountUserId: string | null = null;

  if (session) {
    uploaderWorkspaceUserId = session.user.id;
  } else {
    // Customer side. resolveCustomer reads the JWT from the request headers;
    // the workspace_slug + email come from the already-parsed form for the
    // legacy trusted-email path.
    const r = await resolveCustomer(req, {
      workspaceSlug: form.get("workspace_slug")?.toString() ?? null,
      email: form.get("account_user_email")?.toString() ?? null,
    });
    if (!r.ok) return fail(r.status, r.error);
    uploaderAccountUserId = r.ctx.user.id;
  }

  const file = form.get("file");
  if (!(file instanceof File)) return fail(400, "missing_file");
  if (file.size <= 0) return fail(400, "empty_file");
  if (file.size > MAX_BYTES) return fail(413, "file_too_large");

  const contentType = file.type || "application/octet-stream";
  if (!contentTypeAllowed(contentType)) return fail(415, "unsupported_type");

  const filename = (file.name || "upload").slice(0, 255);
  const key = newStorageKey(filename);
  const bytes = Buffer.from(await file.arrayBuffer());
  await putBytes({ key, bytes, contentType });

  const [row] = await db.insert(attachments).values({
    filename,
    contentType,
    sizeBytes: bytes.length,
    storageKey: key,
    uploadedByWorkspaceUserId: uploaderWorkspaceUserId,
    uploadedByAccountUserId: uploaderAccountUserId,
  }).returning();

  return cors(NextResponse.json({
    id: row!.id,
    filename: row!.filename,
    content_type: row!.contentType,
    size_bytes: row!.sizeBytes,
  }, { status: 201 }));
}
