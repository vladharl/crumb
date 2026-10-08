import "server-only";

// Shared inbound-email text helpers, used by both the reply webhook and the
// forwarded-email capture webhook.

// Header values are cut to this before any regex runs: a real From line is
// far shorter, and a crafted unbounded one can't make a regex backtrack long.
const HEADER_MAX = 1000;

// An address inside a header value: `addr`, `Name <addr>`, Outlook's
// `Name [mailto:addr]` and `Name <addr<mailto:addr>>` all give `addr`.
const ADDRESS = /[^\s<>()[\]",;:]+@[^\s<>()[\]",;:]+/;

// Pull the bare email address out of a `From` header (`Name <addr>` or bare).
export function extractSender(from: string | undefined): string | null {
  if (!from) return null;
  const value = from.slice(0, HEADER_MAX);
  const angle = value.match(/<([^>]+)>/);
  return (angle ? angle[1]! : value).match(ADDRESS)?.[0]?.toLowerCase() ?? null;
}

// Pull a display name out of a `From` header: `Name <addr>`, Outlook's
// `Name [mailto:addr]`, or a bare name. Null for a bare address.
export function extractSenderName(from: string | undefined): string | null {
  if (!from) return null;
  const value = from.slice(0, HEADER_MAX);
  const cut = value.search(/<|\[mailto:/i);
  if (cut < 0 && value.includes("@")) return null;
  // Quotes, and the *bold* some HTML-to-text converters leave on a name.
  const name = (cut < 0 ? value : value.slice(0, cut)).trim().replace(/^["*]+|["*]+$/g, "").trim();
  return name || null;
}

// The email's Message-ID as a dedupe key: trimmed, angle brackets off, and
// capped, since a btree index entry tops out near 2.7KB.
export function normalizeMessageId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return raw.trim().replace(/^<|>$/g, "").trim().slice(0, 512) || null;
}

// Where an ordinary reply's quoted history starts: "On ... wrote:", Outlook's
// "-----Original Message-----" or "From:" header block (and the "____" rule it
// draws above that block), or a "> " quoted line.
function quoteStartsAt(lines: string[], i: number): boolean {
  const line = lines[i]!;
  return /^On\s.*\swrote:\s*$/i.test(line)
    || /^-----Original Message-----\s*$/i.test(line)
    || /^From:\s.+/i.test(line)
    || /^>+\s/.test(line)
    || (/^_{10,}\s*$/.test(line) && /^From:\s/i.test(lines[i + 1] ?? ""));
}

// Strip quoted reply / forward blocks. Conservative — only the lines we're
// confident are quoted history. Keeps everything above the first marker.
export function stripQuotedTail(text: string): string {
  const lines = text.split(/\r?\n/);
  const cutAt = lines.findIndex((_, i) => quoteStartsAt(lines, i));
  return (cutAt < 0 ? lines : lines.slice(0, cutAt)).join("\n").trimEnd();
}

// The line a client puts above a forwarded message: Gmail's "---------- Forwarded
// message ---------", Thunderbird's and Yahoo's "----- Forwarded Message -----",
// Apple Mail's "Begin forwarded message:".
const FORWARD_MARKER = /^\s*(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message\s*:)\s*$/i;
// One line of a forwarded message's header block. ponytail: English labels only.
const HEADER_LINE = /^\s*\*?(From|Sent|Date|To|Cc|Bcc|Reply-To|Subject)\*?\s*:\s*\*?\s*(.*)$/i;
const FORWARD_SUBJECT = /^(?:\s*fwd?:)+\s*/i;

type Forward = { from: string; subject: string | null; content: string };

// The header block (From, Sent or Date, To, Cc, Subject) at lines[start], past
// blank lines, and the message under it. Null unless it names a sender.
function readHeaderBlock(lines: string[], start: number): Forward | null {
  let i = start;
  while (i < lines.length && !lines[i]!.trim()) i++;
  let from: string | null = null;
  let subject: string | null = null;
  let n = 0;
  for (; i < lines.length; i++, n++) {
    const m = HEADER_LINE.exec(lines[i]!);
    if (!m) break;
    const key = m[1]!.toLowerCase();
    if (key === "from") from ??= m[2]!.trim();
    else if (key === "subject") subject ??= m[2]!.trim();
  }
  if (!from || n < 2) return null;
  return { from, subject: subject || null, content: lines.slice(i).join("\n").trim() };
}

// The message forwarded in `text`, or null when this isn't a forward. Gmail,
// Apple Mail, Thunderbird and Yahoo put a marker line above it. Outlook only
// says so in the subject (FW:), then starts the same header block it uses to
// quote a reply. A marker only counts above any quoted history, so a reply
// that quotes a forward stays a reply.
function readForward(subject: string | null, text: string): Forward | null {
  const lines = text.split(/\r?\n/);
  const fwdSubject = !!subject && FORWARD_SUBJECT.test(subject);
  for (let i = 0; i < lines.length; i++) {
    if (FORWARD_MARKER.test(lines[i]!)) {
      let rest = lines.slice(i + 1);
      // Apple Mail quotes what it forwards ("> From: ..."): take one level off.
      if (rest.find((l) => l.trim())?.startsWith(">")) rest = rest.map((l) => l.replace(/^> ?/, ""));
      return readHeaderBlock(rest, 0);
    }
    if (!quoteStartsAt(lines, i)) continue;
    if (!fwdSubject) return null; // an ordinary reply's quoted history
    const block = readHeaderBlock(lines, i);
    if (block) return block;
  }
  return null;
}

export type InboundMail = { from?: string; subject?: string; text?: string };
export type CaptureFields = { fromEmail: string | null; fromName: string | null; subject: string | null; body: string };

// Who a mail to the capture address is from and what it says. A forward is
// the forwarded message: attributed to its original sender, its own quoted
// history stripped, under a note line naming the teammate who forwarded it.
// Any other mail is its sender's own words above the quoted history.
export function captureFromEmail(mail: InboundMail): CaptureFields {
  const subject = mail.subject?.trim() || null;
  const text = (mail.text ?? "").trim();
  const senderEmail = extractSender(mail.from);
  const senderName = extractSenderName(mail.from);
  let fwd = readForward(subject, text);
  if (!fwd) return { fromEmail: senderEmail, fromName: senderName, subject, body: stripQuotedTail(text) };

  // A forward of a forward (support to a PM to here): the innermost message is
  // the customer's. ponytail: 5 levels deep, past that the 6th sender stands.
  for (let depth = 0; depth < 5; depth++) {
    const inner = readForward(fwd.subject, fwd.content);
    if (!inner) break;
    fwd = inner;
  }
  const fromEmail = extractSender(fwd.from);
  const body = stripQuotedTail(fwd.content);
  const forwarder = senderName && senderEmail ? `${senderName} (${senderEmail})` : senderEmail ?? senderName;
  const note = forwarder && !(senderEmail && senderEmail === fromEmail) ? `Forwarded by ${forwarder}` : null;
  return {
    fromEmail,
    fromName: extractSenderName(fwd.from),
    subject: (fwd.subject ?? subject)?.replace(FORWARD_SUBJECT, "") || null,
    body: note ? `${note}\n\n${body}`.trimEnd() : body,
  };
}
