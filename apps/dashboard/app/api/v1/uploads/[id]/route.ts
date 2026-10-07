import { db, attachments, replies, items, workspaces } from "@crumb/db";
import { eq } from "drizzle-orm";
import { CORS_HEADERS, fail, preflight, resolveCustomer } from "@/lib/public-api";
import { getSession } from "@/lib/auth";
import { getBytes } from "@/lib/storage";
import { verifyAttachmentLink } from "@/lib/attachments/signed-url";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function OPTIONS() {
  return preflight();
}

// ─── GET /api/v1/uploads/[id] ──────────────────────────────────
// Downloads the file bytes for a given attachment id. Authorization
// is identity-aware:
//   - signed link (?exp&sig, lib/attachments/signed-url) → allowed until it
//     expires; how the widget opens files, since a new tab sends no JWT
//   - vendor session that owns the workspace → allowed
//   - customer (JWT/email) that submitted the parent item → allowed
//   - otherwise 403
// Unlinked attachments (reply_id IS NULL — still in the "uploaded but
// not yet attached to a reply" window) are only accessible to the
// uploader, so a malicious actor can't fetch other vendors' draft files.
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const id = params.id;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return fail(400, "bad_id");
  }

  // Load attachment + the parent reply + item so we can authorize.
  const [row] = await db
    .select({
      id: attachments.id,
      replyId: attachments.replyId,
      filename: attachments.filename,
      contentType: attachments.contentType,
      sizeBytes: attachments.sizeBytes,
      storageKey: attachments.storageKey,
      uploadedByWorkspaceUserId: attachments.uploadedByWorkspaceUserId,
      uploadedByAccountUserId: attachments.uploadedByAccountUserId,
      itemWorkspaceId: items.workspaceId,
      itemSubmitterId: items.submitterId,
      signingSecret: workspaces.signingSecret,
    })
    .from(attachments)
    .leftJoin(replies, eq(replies.id, attachments.replyId))
    .leftJoin(items, eq(items.id, replies.itemId))
    .leftJoin(workspaces, eq(workspaces.id, items.workspaceId))
    .where(eq(attachments.id, id))
    .limit(1);
  if (!row) return fail(404, "not_found");

  // Authorize. A signed link only exists for linked attachments (no item →
  // no secret), and it's checked against the stored id, so it opens this
  // attachment and nothing else.
  const url = new URL(req.url);
  let allowed = row.signingSecret !== null
    && verifyAttachmentLink(row.id, url.searchParams.get("exp"), url.searchParams.get("sig"), row.signingSecret);

  const session = allowed ? null : await getSession();
  if (session) {
    // Vendor: same workspace, or uploader.
    if (row.itemWorkspaceId && row.itemWorkspaceId === session.workspace.id) allowed = true;
    if (!row.replyId && row.uploadedByWorkspaceUserId === session.user.id) allowed = true;
  }

  if (!allowed) {
    // Customer path. Slug + email come from query (legacy) or JWT.
    const r = await resolveCustomer(req, {
      workspaceSlug: url.searchParams.get("workspace"),
      email: url.searchParams.get("email"),
    });
    if (r.ok) {
      // Allowed when the caller is the submitter of the parent item, OR
      // when the caller uploaded this attachment (draft window).
      if (row.itemSubmitterId && row.itemSubmitterId === r.ctx.user.id) allowed = true;
      if (!row.replyId && row.uploadedByAccountUserId === r.ctx.user.id) allowed = true;
    }
  }

  if (!allowed) return fail(403, "forbidden");

  const bytes = await getBytes(row.storageKey);
  if (!bytes) return fail(404, "bytes_not_found");

  // The uploader picks the Content-Type, and text/* and image/* pass the upload
  // allowlist, so an HTML or SVG file opened here would run script on this
  // origin. Only raster images and PDFs open in the tab; the rest download.
  // The sandbox CSP backs that up, except on PDFs, which Chrome won't render
  // in a sandboxed document.
  const type = row.contentType.toLowerCase();
  const pdf = type === "application/pdf";
  const inline = pdf || /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(type);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": row.contentType,
      "Content-Length": String(row.sizeBytes),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${row.filename.replace(/"/g, "")}"`,
      ...(pdf ? {} : { "Content-Security-Policy": "sandbox" }),
      "Cache-Control": "private, max-age=300",
    },
  });
}
