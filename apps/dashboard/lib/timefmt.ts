// Gmail-style activity timestamps for list rows: precise enough to scan, no
// wider than it needs to be. Pure (now injectable) so it's unit-testable —
// same convention as lib/loop.ts.

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
