// Shared config for the LandingHero composition. The brand palette mirrors the
// app's tokens (apps/dashboard/app/globals.css) so the reel matches the product.
//
// Durations come from clips.json (written by scripts/measure.mjs via ffprobe),
// so each scene is sized to its clip's real length — no freeze, no cut-off.
// clips.json ships with sane defaults so the composition bundles before the
// first capture; `measure` overwrites it with the true values.
import clipDurations from "./clips.json";

export const FPS = 30;

export const BRAND = {
  cream: "#FBF7F0",
  creamSoft: "#FDFAF4",
  cream2: "#F4EEE2",
  ink: "#1A1815",
  brown: "#4A2E1F", // primary ink
  ember: "#E27D3A", // "the trail" — accent
  emberDeep: "#B45F23",
  green: "#6B8E5A",
  amber: "#D4A24C",
  warmGray: "#8A8278",
};

export interface Scene {
  clip: string;       // file under public/clips (no extension)
  act: string;        // "Act 1" …
  title: string;
  caption: string;
  seconds: number;    // real clip duration from clips.json
}

const dur = (name: string, fallback: number): number =>
  (clipDurations as Record<string, number>)[name] ?? fallback;

// One scene per act — the three experiences, in order.
export const SCENES: Scene[] = [
  {
    clip: "act1-customer",
    act: "Act 1 · Your customer",
    title: "Feedback, right inside your product",
    caption: "Customers drop a note without leaving the app, then watch your public roadmap.",
    seconds: dur("act1-customer", 20),
  },
  {
    clip: "act2-vendor-loop",
    act: "Act 2 · Your product team",
    title: "Reply, then put it on the roadmap",
    caption: "It lands in the product team's inbox. They answer the customer and make the work public.",
    seconds: dur("act2-vendor-loop", 24),
  },
  {
    clip: "act3-prioritize-ship",
    act: "Act 3 · Prioritize & ship",
    title: "Weigh by revenue, ship to Linear",
    caption: "See the ARR behind each ask, then send it to engineering as an AI-drafted ticket.",
    seconds: dur("act3-prioritize-ship", 18),
  },
];

export const INTRO_SECONDS = 3.5;
export const OUTRO_SECONDS = 3.5;
