import "server-only";
import { randomBytes } from "node:crypto";
import type { StorageProvider } from "./storage/provider";
import { localStorage_ } from "./storage/local";

// Pick by env. v1 ships only "local" — s3 adapter lands in a follow-up turn.
// Both Cloud and self-host default here until s3 is wired.
function selectProvider(): StorageProvider {
  const choice = (process.env.CRUMB_STORAGE_PROVIDER ?? "local").toLowerCase();
  if (choice !== "local") {
    console.warn(`[crumb/storage] CRUMB_STORAGE_PROVIDER=${choice} is not implemented yet; falling back to local.`);
  }
  return localStorage_;
}

let cached: StorageProvider | null = null;
function provider(): StorageProvider {
  if (!cached) cached = selectProvider();
  return cached;
}

// Generate a sharded random key so a directory doesn't end up with 100k
// files in one place. yyyy/mm/dd/<24-char base32-ish hex>.
export function newStorageKey(filename: string): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const rand = randomBytes(12).toString("hex");
  // Preserve the original extension for slightly better content sniffing
  // by downstream tools. Strip everything else (no path traversal risk
  // since the key is otherwise random).
  const ext = filename.match(/\.[A-Za-z0-9]{1,8}$/)?.[0]?.toLowerCase() ?? "";
  return `${yyyy}/${mm}/${dd}/${rand}${ext}`;
}

export async function putBytes(opts: { key: string; bytes: Buffer; contentType: string }): Promise<void> {
  await provider().put(opts);
}

export async function getBytes(key: string): Promise<Buffer | null> {
  const r = await provider().get(key);
  return r?.bytes ?? null;
}

export async function deleteBytes(key: string): Promise<void> {
  await provider().delete(key);
}

export function activeStorageProvider(): { name: string } {
  return { name: provider().name };
}
