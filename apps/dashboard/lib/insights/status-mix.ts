import type { Status } from "@crumb/ui";

// Status buckets for the account hero + sidebar and the initiative header,
// counted from per-status rows. One mapping so those surfaces agree: every
// status lands in exactly one bucket, declined and deferred stay apart, and
// "deferred" (Set aside) is an open loop, never folded into a closed bucket.
export type StatusMix = {
  open: number;        // open + review
  progress: number;    // planned + progress
  deferred: number;    // Set aside: paused, still an open loop
  shipped: number;
  declined: number;
  otherClosed: number; // duplicate + resolved (the customer closed it)
  total: number;
};

const BUCKET: Record<Status, Exclude<keyof StatusMix, "total">> = {
  open: "open", review: "open",
  planned: "progress", progress: "progress",
  deferred: "deferred",
  shipped: "shipped",
  declined: "declined",
  duplicate: "otherClosed", resolved: "otherClosed",
};

export function statusMix(rows: ReadonlyArray<{ status: string; count: number }>): StatusMix {
  const mix: StatusMix = { open: 0, progress: 0, deferred: 0, shipped: 0, declined: 0, otherClosed: 0, total: 0 };
  for (const { status, count } of rows) {
    // An unknown status isn't closed, so it's an open loop (as in loopTurn).
    mix[BUCKET[status as Status] ?? "open"] += count;
    mix.total += count;
  }
  return mix;
}
