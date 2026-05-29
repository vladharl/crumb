import "server-only";
import { eq } from "drizzle-orm";
import { db, storageBlobs } from "@crumb/db";
import type { StorageProvider } from "./provider";

// Postgres-backed blob store. Lets a multi-instance Cloud deployment share
// attachment + replay-chunk bytes through the DB instead of a per-instance
// local disk or an S3 dependency. Bytes are base64-encoded in a text column
// (see packages/db schema `storage_blobs`) — simple + driver-safe; a real
// S3/R2 adapter is the eventual home for large blobs.
//
// Keys are opaque (same `newStorageKey()` the local provider uses), so
// callers (uploads, replay ingest) need no changes when this is selected.
export const postgresStorage_: StorageProvider = {
  name: "postgres",

  async put({ key, bytes, contentType }) {
    const dataB64 = bytes.toString("base64");
    // Upsert so a retried chunk/attachment write with the same key is
    // idempotent rather than a primary-key violation.
    await db
      .insert(storageBlobs)
      .values({ key, contentType, dataB64, sizeBytes: bytes.byteLength })
      .onConflictDoUpdate({
        target: storageBlobs.key,
        set: { contentType, dataB64, sizeBytes: bytes.byteLength },
      });
  },

  async get(key) {
    const [row] = await db
      .select({ dataB64: storageBlobs.dataB64, contentType: storageBlobs.contentType })
      .from(storageBlobs)
      .where(eq(storageBlobs.key, key))
      .limit(1);
    if (!row) return null;
    return { bytes: Buffer.from(row.dataB64, "base64"), contentType: row.contentType };
  },

  async delete(key) {
    await db.delete(storageBlobs).where(eq(storageBlobs.key, key));
  },
};
