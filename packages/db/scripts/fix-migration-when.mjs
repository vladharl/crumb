// Post-`drizzle-kit generate` fixup.
//
// The runtime migrator applies a migration iff `lastApplied.created_at <
// migration.when` (the journal's `when`). Our history was squashed to a
// baseline whose `when` sits ABOVE the timestamps already recorded on any
// previously-migrated DB. drizzle-kit stamps new migrations with the real
// wall-clock, which can be BELOW that — so a freshly generated migration
// could be silently skipped on an existing DB.
//
// This script guarantees strict monotonicity: the newest journal entry's
// `when` is forced just above the max of all prior entries. Run automatically
// by `pnpm --filter @crumb/db generate`. Idempotent.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const journalPath = resolve(here, "..", "drizzle", "meta", "_journal.json");

const journal = JSON.parse(readFileSync(journalPath, "utf8"));
const entries = journal.entries ?? [];
if (entries.length < 2) {
  console.log("[fix-when] <2 migrations; nothing to do");
  process.exit(0);
}

const newest = entries[entries.length - 1];
const priorMax = Math.max(...entries.slice(0, -1).map(e => e.when));
if (newest.when <= priorMax) {
  const bumped = priorMax + 1000;
  console.log(`[fix-when] ${newest.tag}: when ${newest.when} ≤ prior max ${priorMax} → ${bumped}`);
  newest.when = bumped;
  writeFileSync(journalPath, JSON.stringify(journal, null, 2) + "\n");
} else {
  console.log(`[fix-when] ${newest.tag}: when ${newest.when} already > prior max ${priorMax}; ok`);
}
