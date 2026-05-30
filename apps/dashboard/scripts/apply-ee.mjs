#!/usr/bin/env node
// apply-ee.mjs — overlay the cloud-only ("ee") route files into the Next `app/`
// tree, or strip them back out.
//
//   node scripts/apply-ee.mjs apply   # copy ee/app/** -> app/**  (cloud + dev)
//   node scripts/apply-ee.mjs strip   # remove the overlaid files (community)
//
// Why: the community / self-host edition must ship WITHOUT the cloud-only
// surfaces (Stripe billing, session-replay APIs). Their canonical source lives
// only in apps/dashboard/ee/app/**; the mirrored paths under app/** are
// .gitignore'd and regenerated here. A community build never runs `apply`, so
// Next never sees those routes and they 404 on self-host.
//
// `apply` and `strip` are both idempotent and self-correcting: a build for one
// edition fixes whatever the previous build (or a stray local `pnpm dev`) left
// behind, so the Docker build doesn't depend on the incoming working-tree state.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboardRoot = path.resolve(here, "..");
const eeAppRoot = path.join(dashboardRoot, "ee", "app");
const appRoot = path.join(dashboardRoot, "app");

/** Recursively list every file under `dir` (absolute paths); [] if absent. */
async function walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

/** Remove `dir` and each empty ancestor, stopping before `stopAt`. */
async function pruneEmptyDirs(dir, stopAt) {
  let cur = dir;
  while (cur.startsWith(stopAt) && cur !== stopAt) {
    try {
      await fs.rmdir(cur); // only succeeds if empty
    } catch {
      return; // non-empty (or gone) — stop climbing
    }
    cur = path.dirname(cur);
  }
}

async function apply() {
  const files = await walk(eeAppRoot);
  for (const src of files) {
    const dest = path.join(appRoot, path.relative(eeAppRoot, src));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  }
  console.log(`[apply-ee] apply: overlaid ${files.length} cloud file(s) into app/`);
}

async function strip() {
  const files = await walk(eeAppRoot);
  let removed = 0;
  for (const src of files) {
    const dest = path.join(appRoot, path.relative(eeAppRoot, src));
    try {
      await fs.rm(dest);
      removed++;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    await pruneEmptyDirs(path.dirname(dest), appRoot);
  }
  console.log(`[apply-ee] strip: removed ${removed} cloud file(s) from app/`);
}

const mode = process.argv[2];
if (mode === "apply") await apply();
else if (mode === "strip") await strip();
else {
  console.error("usage: node scripts/apply-ee.mjs <apply|strip>");
  process.exit(1);
}
