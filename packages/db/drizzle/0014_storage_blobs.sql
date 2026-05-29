-- Phase 11: Postgres-backed blob storage.
--
-- Interim object store so Cloud (multi-instance) can share attachment +
-- replay-chunk bytes via the DB instead of a per-instance local disk.
-- Selected at runtime via CRUMB_STORAGE_PROVIDER=postgres; self-host stays
-- on the local-disk provider by default. Bytes are base64-encoded text
-- (avoids postgres.js bytea quirks); S3/R2 remains the eventual home for
-- large blobs.

CREATE TABLE "storage_blobs" (
  "key" text PRIMARY KEY NOT NULL,
  "content_type" text NOT NULL,
  "data_b64" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
