// Dates for people, in one format: "7 Oct" this year, "7 Oct 2025" otherwise,
// and "May 2024" for a month. Day first with a named month, so nothing reads
// like "May 24" (the 24th? 2024?) or "6/12/24" (June or December?). Pure (now
// injectable) so it's unit-testable — same convention as lib/loop.ts.
//
// Formats in the runtime's local zone, so an SSR'd value (server zone) and the
// hydrated value (viewer's zone) differ by design. When rendering this in a
// client component, pass a server-seeded `now` for branch stability AND set
// `suppressHydrationWarning` on the element (see LoopAge in InboxTable.tsx) so
// the mismatch doesn't tip React into a full-root client re-render. `utc` reads
// the calendar in UTC instead: for date-only values ("2026-10-07" parses as UTC
// midnight) and pages that must read the same on server and client.

// ponytail: fixed English names, not Intl: ICU builds disagree ("Sep" vs "Sept"),
// which would break hydration. Swap for Intl when the dashboard is localized.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function calendar(value: Date | string, utc: boolean) {
  const d = new Date(value);
  return utc
    ? { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate() }
    : { y: d.getFullYear(), m: d.getMonth(), day: d.getDate() };
}

/** "7 Oct" this year, "7 Oct 2025" otherwise; `year` always shows it (print). */
export function formatDate(
  value: Date | string,
  { now = new Date(), utc = false, year = false }: { now?: Date; utc?: boolean; year?: boolean } = {},
): string {
  const d = calendar(value, utc);
  const showYear = year || d.y !== calendar(now, utc).y;
  return `${d.day} ${MONTHS[d.m]}${showYear ? ` ${d.y}` : ""}`;
}

/** Month and full year: "May 2024", never "May 24". */
export function formatMonth(value: Date | string): string {
  const d = calendar(value, false);
  return `${MONTHS[d.m]} ${d.y}`;
}

// Gmail-style activity timestamps for list rows: the time for today, the date
// otherwise. Precise enough to scan, no wider than it needs to be.
export function gmailTime(value: Date | string, now: Date = new Date()): string {
  const d = new Date(value);
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  return formatDate(d, { now });
}
