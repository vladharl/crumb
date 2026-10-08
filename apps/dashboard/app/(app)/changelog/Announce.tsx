"use client";

import { useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Btn } from "@crumb/ui";
import type { Announce, Audience, PublishResult, Skipped } from "@/lib/changelog";
import { runAction, sourceLabel } from "@/components/ReplyComposer";
import { useConfirm } from "@/components/confirm";
import { useToast } from "@/components/toast";
import { publishEntry } from "./actions";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// "12 customers and 4 followers", "4 followers".
const whom = (customers: number, followers: number) =>
  [customers > 0 ? count(customers, "customer") : null, followers > 0 ? count(followers, "follower") : null]
    .filter(Boolean).join(" and ");

// Customers a Shipped email about their own request already told.
const heardLine = (n: number) => (n > 0 ? `${n} already heard when their request shipped.` : null);

// "a or b", "a, b, or c".
function orList(parts: string[]): string {
  return parts.length <= 2 ? parts.join(" or ") : `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`;
}

// "3 can't be emailed: they came in through Zendesk or turned updates off."
export function skippedLine(s: Skipped): string | null {
  if (s.count === 0) return null;
  const why = [
    ...(s.sources.length > 0 ? [`came in through ${orList(s.sources.map(sourceLabel))}`] : []),
    ...(s.noEmail ? ["have no email address"] : []),
    ...(s.muted ? ["turned updates off"] : []),
  ];
  return `${s.count} can't be emailed${why.length > 0 ? `: they ${orList(why)}` : ""}.`;
}

// Before publishing: who it will email, and who it can't reach.
export function audienceLine(a: Audience): string {
  if (!a.emailOn) return "Email isn't set up yet, so publishing won't email anyone.";
  const who = [
    a.reach > 0 ? `${count(a.reach, "customer")} who asked for this or follow it` : null,
    a.followers > 0 ? `${count(a.followers, "follower")} of your public pages` : null,
  ].filter(Boolean);
  const reach = who.length > 0
    ? `Publishing emails ${who.join(", and ")}.`
    : a.skipped.count > 0 || a.alreadyHeard > 0
      ? "No one will be emailed."
      : "No one has asked for this or followed it yet, so no one will be emailed.";
  return [reach, heardLine(a.alreadyHeard), skippedLine(a.skipped)].filter(Boolean).join(" ");
}

// After publishing: what actually went out. A hand-written entry emails no
// customer, so it never says it was announced.
export function publishedMessage(r: Extract<PublishResult, { ok: true }>): string {
  if (!r.announced) return r.followers > 0 ? `Published. Sent to ${count(r.followers, "follower")}.` : "Published to your changelog.";
  return [
    !r.emailOn
      ? "Published. Email isn't set up, so no one was emailed."
      : r.delivered + r.followers > 0 ? `Sent to ${whom(r.delivered, r.followers)}.` : "Published. No one was emailed.",
    r.emailOn && r.failed > 0 ? `${count(r.failed, "email")} didn't go through.` : null,
    r.marked > 0 ? `Marked ${count(r.marked, "request")} Shipped.` : null,
    r.emailOn ? skippedLine(r.skipped) : null,
  ].filter(Boolean).join(" ");
}

/**
 * Publishing an entry that emails someone (an initiative's, or one the public
 * followers get): who it reaches, the offer to mark the initiative's open
 * requests Shipped in the same step, and a confirm with the count before
 * anything is sent. The toast reports what was actually delivered.
 */
export function AnnounceControls({ entryId, title, audience, onPublished, children }: {
  entryId: string;
  title: string;
  audience: Audience;
  onPublished?: () => void;
  children?: ReactNode; // more actions beside Publish
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const { reach, followers, alreadyHeard, emailOn, openItems } = audience;
  const [mark, setMark] = useState(openItems > 0);
  const [pending, start] = useTransition();
  const marking = mark && openItems > 0;
  const toCustomers = emailOn && reach > 0;
  const emails = emailOn && reach + followers > 0;

  async function publish() {
    // Marking requests Shipped can email the customers this can't reach.
    if (emailOn && (emails || marking) && !(await confirm({
      title: emails ? `Email ${whom(reach, followers)}?` : `Mark ${count(openItems, "request")} Shipped?`,
      body: [
        toCustomers ? `“Shipped: ${title}” goes to everyone who asked for this or follows it.` : null,
        followers > 0
          ? `${toCustomers ? "It also goes" : `“${title}” goes`} to ${count(followers, "follower")} of your public pages.`
          : null,
        emails ? null : "No one gets this announcement by email.",
        heardLine(alreadyHeard),
        marking
          ? `The initiative's ${count(openItems, "open request")} move to Shipped too. Customers who get this announcement aren't sent a separate Shipped email. Anyone else who gets Shipped emails still gets one.`
          : null,
      ].filter(Boolean).join(" "),
      confirmLabel: emails ? `Publish and email ${reach + followers}` : "Publish and mark Shipped",
    }))) return;
    start(async () => {
      const r = await runAction(toast, () => publishEntry(entryId, { markShipped: marking }));
      if (!r) return;
      toast.show({ message: publishedMessage(r) });
      router.refresh();
      onPublished?.();
    });
  }

  return (
    <div className="col gap-2">
      <span className="text-xs muted">{audienceLine(audience)}</span>
      {openItems > 0 && (
        <label className="row gap-2 text-xs" style={{ alignItems: "flex-start" }}>
          <input type="checkbox" checked={mark} disabled={pending} onChange={e => setMark(e.target.checked)} />
          <span>
            Mark the initiative's {count(openItems, "open request")} Shipped too.{" "}
            {toCustomers && (
              <span className="muted">
                {mark
                  ? "Customers who get this announcement aren't sent a separate Shipped email."
                  : "Marking them Shipped later emails those customers again."}
              </span>
            )}
          </span>
        </label>
      )}
      <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
        <Btn sm variant="primary" disabled={pending} onClick={publish}>
          {pending ? "Publishing…" : emails ? `Publish and email ${reach + followers}` : "Publish"}
        </Btn>
        {children}
      </div>
    </div>
  );
}

/** The prompt an initiative shows when it ships: the announcement as customers will read it, ready to send. */
export function AnnouncePrompt({ announce, onClose }: { announce: Announce; onClose: () => void }) {
  const a = announce.audience;
  return (
    <div
      className="col gap-3"
      style={{ background: "var(--paper)", border: "1px solid var(--line)", borderRadius: "var(--r-sm)", padding: 12 }}
    >
      <span className="eyebrow">{a.emailOn && a.reach + a.followers > 0 ? `Announce to ${whom(a.reach, a.followers)}` : "Publish to your changelog"}</span>
      <div className="col gap-1">
        <span className="text-sm fw-med">Shipped: {announce.title}</span>
        <p className="text-sm muted" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
          {announce.body.trim() || "It's live now."}
        </p>
      </div>
      <AnnounceControls entryId={announce.entryId} title={announce.title} audience={a} onPublished={onClose}>
        <Btn sm onClick={onClose}>Not now</Btn>
        <Link href="/changelog" className="text-xs">Edit it in Changelog</Link>
      </AnnounceControls>
    </div>
  );
}
