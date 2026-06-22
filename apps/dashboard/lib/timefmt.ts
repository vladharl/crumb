// Gmail-style activity timestamps for list rows: precise enough to scan, no
// wider than it needs to be. Pure (now injectable) so it's unit-testable —
// same convention as lib/loop.ts.
//
// Formats in the runtime's local zone, so an SSR'd value (server zone) and the
// hydrated value (viewer's zone) differ by design. When rendering this in a
// client component, pass a server-seeded `now` for branch stability AND set
// `suppressHydrationWarning` on the element (see LoopAge in InboxTable.tsx) so
// the mismatch doesn't tip React into a full-root client re-render.

export function gmailTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" });
}
