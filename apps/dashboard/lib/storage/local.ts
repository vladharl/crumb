import "server-only";
import { promises as fs } from "node:fs";
import { join, dirname } from "node:path";
import type { StorageProvider } from "./provider";

// Files live under CRUMB_STORAGE_DIR (defaults to .crumb-uploads at the
// dashboard process root). The dir is OUTSIDE public/ so files aren't
// trivially served — downloads go through /api/v1/uploads/[id], which
// enforces authorization. Keys are stored verbatim and resolved relative
// to the root.

const ROOT = process.env.CRUMB_STORAGE_DIR?.trim()
  || join(process.cwd(), ".crumb-uploads");

export const localStorage_: StorageProvider = {
  name: "local",
  async put({ key, bytes }) {
    const path = join(ROOT, key);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, bytes);
  },
  async get(key) {
    const path = join(ROOT, key);
    try {
      const bytes = await fs.readFile(path);
      // Caller provides contentType from DB; provider doesn't infer.
      return { bytes, contentType: "application/octet-stream" };
    } catch (e: unknown) {
      if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "ENOENT") return null;
      throw e;
    }
  },
  async delete(key) {
    const path = join(ROOT, key);
    try { await fs.unlink(path); } catch { /* swallow */ }
  },
};
