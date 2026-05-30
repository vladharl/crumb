import "server-only";
import { and, isNull, lt, eq } from "drizzle-orm";
import { db, attachments } from "@crumb/db";
import { deleteBytes } from "@/lib/storage";

// Sweep orphan attachments — rows with no `reply_id`, older than the grace
// window. The upload flow is two-phase: the client POSTs the file first
// (row with reply_id = NULL), then submits the reply which links it. An
// abandoned compose (customer uploads, never sends) leaves the row + its
// bytes stranded. The schema flags pruning these as a follow-up; this is it.
//
// Same best-effort storage strategy as the replay sweep: delete the bytes,
// then drop the DB row. A failed byte-delete is counted but doesn't block
// the row delete — orphan blobs are recoverable; orphan rows pointing at
// missing bytes are worse.

export type AttachmentSweepResult = {
  scanned: number;
  deletedAttachments: number;
  releasedBytes: number;
  storageFailures: number;
};

export type AttachmentSweepOptions = {
  // Linking happens within seconds of upload, so even a short grace is safe.
  // Default 1h matches the schema's documented intent and tolerates a slow
  // reply compose.
  graceMs?: number;
  limit?: number;
};

const DEFAULT_GRACE_MS = 60 * 60 * 1000; // 1h
const DEFAULT_LIMIT = 500;

export async function sweepOrphanAttachments(opts: AttachmentSweepOptions = {}): Promise<AttachmentSweepResult> {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const cutoff = new Date(Date.now() - graceMs);

  const candidates = await db
    .select({ id: attachments.id, storageKey: attachments.storageKey, sizeBytes: attachments.sizeBytes })
    .from(attachments)
    .where(and(
      isNull(attachments.replyId),
      lt(attachments.createdAt, cutoff),
    ))
    .limit(limit);

  if (candidates.length === 0) {
    return { scanned: 0, deletedAttachments: 0, releasedBytes: 0, storageFailures: 0 };
  }

  let releasedBytes = 0;
  let storageFailures = 0;
  for (const a of candidates) {
    try {
      await deleteBytes(a.storageKey);
      releasedBytes += a.sizeBytes;
    } catch {
      storageFailures += 1;
    }
    await db.delete(attachments).where(eq(attachments.id, a.id));
  }

  return {
    scanned: candidates.length,
    deletedAttachments: candidates.length,
    releasedBytes,
    storageFailures,
  };
}
