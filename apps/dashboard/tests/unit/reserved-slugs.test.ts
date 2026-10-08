import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@crumb/db";
import { RESERVED_SLUGS, ensureUniqueSlug } from "@/lib/provision";

// The public pages live at /<slug>/roadmap beside the app's own top-level
// routes, and a static route always wins over [slug]. So every top-level
// route name stays out of reach of workspace slugs: this fails when a new one
// lands without being added to RESERVED_SLUGS.

const root = resolve(__dirname, "../..");
// Route segments only: skip (groups), [dynamic] segments and _private folders.
const segments = (dir: string) =>
  readdirSync(resolve(root, dir), { withFileTypes: true })
    .filter(d => d.isDirectory() && !/^[([_]/.test(d.name))
    .map(d => d.name);

const reachable = await db.execute(sql`select 1`).then(() => true, () => false);

describe("reserved slugs", () => {
  it("cover every top-level route in app/ and ee/app/", () => {
    const routes = ["app", "app/(app)", "ee/app", "ee/app/(app)"].flatMap(segments);
    expect(routes.length).toBeGreaterThan(10);
    expect(routes.filter(r => !RESERVED_SLUGS.has(r))).toEqual([]);
  });

  it.skipIf(!reachable && !process.env.CI)("are skipped when signup derives a slug", async () => {
    expect(await ensureUniqueSlug("inbox")).toMatch(/^inbox-\d+$/);
  });
});
