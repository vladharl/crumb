import "server-only";

// Generic blob-storage adapter. Local-disk by default for self-host; an S3
// adapter (Cloudflare R2 / AWS S3 / MinIO) will land in a follow-up turn.
// All file IO is keyed on an opaque storage_key the schema stores verbatim;
// providers control what that string means physically.

export type StorageProvider = {
  name: string;
  /** Write the bytes; returns the opaque storage key (caller persists it). */
  put(opts: { key: string; bytes: Buffer; contentType: string }): Promise<void>;
  /** Read the bytes back. Returns null when the key isn't found. */
  get(key: string): Promise<{ bytes: Buffer; contentType: string } | null>;
  /** Hard-delete; used on attachment row delete cascade or admin cleanup. */
  delete(key: string): Promise<void>;
};
