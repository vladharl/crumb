#!/usr/bin/env node
// Measure each captured clip's real duration with ffprobe and write
// demos/remotion/clips.json. Remotion imports that JSON at bundle time to size
// each Series.Sequence to its clip's exact length — so a clip never freezes on
// its last frame (Sequence too long) or gets cut off mid-action (too short).

import { execSync } from "node:child_process";
import { readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");
const CLIPS = join(PKG, "public", "clips");
const OUT = join(PKG, "remotion", "clips.json");

if (!existsSync(CLIPS)) {
  console.error(`[measure] no clips dir at ${CLIPS} — run capture first.`);
  process.exit(1);
}

const durations = {};
for (const f of readdirSync(CLIPS).filter((f) => f.endsWith(".webm")).sort()) {
  const name = f.replace(/\.webm$/, "");
  const out = execSync(
    `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${join(CLIPS, f)}"`,
    { encoding: "utf8" },
  ).trim();
  const secs = Number(out);
  if (!Number.isFinite(secs) || secs <= 0) {
    console.error(`[measure] could not read duration for ${f} (got "${out}")`);
    process.exit(1);
  }
  durations[name] = Math.round(secs * 1000) / 1000;
  console.log(`[measure] ${name} → ${durations[name]}s`);
}

writeFileSync(OUT, JSON.stringify(durations, null, 2) + "\n");
console.log(`[measure] wrote ${OUT}`);
