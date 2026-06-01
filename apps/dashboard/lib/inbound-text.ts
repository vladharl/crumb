import "server-only";

// Shared inbound-email text helpers, used by both the reply webhook and the
// new-item (forwarded email) webhook.

// Pull the bare email address out of a `From` header (`Name <addr>` or bare).
export function extractSender(from: string | undefined): string | null {
  if (!from) return null;
  const angle = from.match(/<([^>]+)>/);
  const addr = (angle ? angle[1]! : from).trim().toLowerCase();
  if (!addr.includes("@")) return null;
  return addr;
}

// Pull a display name out of a `From` header, if present (`Name <addr>`).
export function extractSenderName(from: string | undefined): string | null {
  if (!from) return null;
  const angle = from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  const name = angle?.[1]?.trim();
  return name && name.length > 0 ? name : null;
}

// Strip quoted reply / forward blocks. Conservative — only the lines we're
// confident are quoted history. Keeps everything above the first marker.
export function stripQuotedTail(text: string): string {
  const lines = text.split(/\r?\n/);
  const markers: RegExp[] = [
    /^On\s.+\s+wrote:\s*$/i,
    /^-----Original Message-----\s*$/i,
    /^From:\s.+/i,
    /^>+\s/,
  ];
  let cutAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (markers.some((re) => re.test(line))) { cutAt = i; break; }
  }
  return lines.slice(0, cutAt).join("\n").trimEnd();
}
