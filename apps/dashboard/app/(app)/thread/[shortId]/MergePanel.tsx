"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Btn, Card, CardHead, Ic, Pill, statusLabel } from "@crumb/ui";
import { useToast } from "@/components/toast";
import { useConfirm } from "@/components/confirm";
import { cancelWaitingMove, firstName, noEmailNote } from "@/components/ReplyComposer";
import { errorMessage } from "@/lib/action-error";
import type { NotifyPlan } from "@/lib/notify/customer-plan";
import {
  mergeItems,
  mergeNotice,
  unmergeItem,
  dismissDuplicateSuggestion,
  listDuplicateCandidates,
  type DuplicateCandidateView,
} from "./actions";

export type ThreadMergeData = {
  // Set when THIS item is itself a duplicate folded into another.
  mergedInto: { shortId: string; title: string } | null;
  // Duplicates folded into this (canonical) item.
  mergedCount: number;
  combinedArrCents: number;
  // Distinct accounts across the merge group — the inbox's "reach" / the unit
  // of revenue priority. followerCount (distinct people) is secondary.
  accountCount: number;
  followerCount: number;
  // Pending capture-time dedupe suggestion (this item ~ candidate).
  pendingSuggestion: { candidateShortId: string; candidateTitle: string; similarity: number } | null;
  // Whether on-demand "find similar" is available (Cloud + AI; embeddings exist).
  dedupAvailable: boolean;
};

function formatArr(cents: number): string {
  if (!cents) return "$0";
  if (cents >= 100_000_000) return `$${(cents / 100_000_000).toFixed(1)}M`;
  if (cents >= 100_000) return `$${Math.round(cents / 100_000)}k`;
  return `$${Math.round(cents / 100)}`;
}

const requests = (n: number) => (n === 1 ? "1 request" : `${n} requests`);

// The merge confirm, in plain words: which way it goes, who follows what from
// now on, and the one email the source's customer gets (or why they don't).
// `notice` is mergeNotice's answer for the source.
export function mergeConfirmBody(
  source: string,
  target: string,
  notice: { name: string; accountName: string; source: string | null; plan: NotifyPlan; carried?: number },
): string {
  const first = firstName(notice.name);
  return [
    `${source} folds into ${target}. ${source}'s customer follows ${target} from now on.`,
    notice.carried && `So do the ${requests(notice.carried)} already merged into ${source}.`,
    noEmailNote(notice.plan, "status", first, notice.source)
      ?? `${first} at ${notice.accountName} will get one email that this was combined.`,
  ].filter(Boolean).join(" ");
}

// After an unmerge: where the item stands again, and who came back with it.
export function unmergedMessage(shortId: string, status: string, carried: number): string {
  return `${shortId} stands on its own again, back to ${statusLabel(status)}.`
    + (carried > 0 ? ` The ${requests(carried)} merged into it came back too.` : "");
}

export function MergePanel({
  itemShortId, canManage, merge,
}: {
  itemShortId: string;
  canManage: boolean;
  merge: ThreadMergeData;
}) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [pending, startTransition] = useTransition();
  const [searching, startSearch] = useTransition();
  const [candidates, setCandidates] = useState<DuplicateCandidateView[] | null>(null);
  const [searched, setSearched] = useState(false);
  // One direction for every merge offered here: this item folds into the one
  // picked, unless the vendor swaps it.
  const [swap, setSwap] = useState(false);

  const fail = (code: string) => toast.show({ message: errorMessage(code), tone: "error" });

  // Merging and unmerging change the source's status, so either wins over a
  // status move still waiting out its undo window. A merge emails the source's
  // submitter once, so the confirm spells out the direction, then who that is
  // or why nobody is emailed, from the plan the server sends by.
  function doMerge(other: string) {
    const [source, target] = swap ? [other, itemShortId] : [itemShortId, other];
    startTransition(async () => {
      const notice = await mergeNotice(source);
      if (!notice.ok) { fail(notice.error); return; }
      if (!(await confirm({
        title: `Merge ${source} into ${target}?`,
        body: mergeConfirmBody(source, target, notice),
        confirmLabel: "Merge",
      }))) return;
      cancelWaitingMove(source);
      const r = await mergeItems(source, target);
      if (!r.ok) { fail(r.error); return; }
      router.refresh();
      toast.show({ message: `Merged ${source} into ${target}. ${firstName(notice.name)} ${r.emailed ? "was" : "wasn't"} emailed.` });
    });
  }
  function doUnmerge() {
    cancelWaitingMove(itemShortId);
    startTransition(async () => {
      const r = await unmergeItem(itemShortId);
      if (!r.ok) { fail(r.error); return; }
      router.refresh();
      toast.show({ message: unmergedMessage(itemShortId, r.status, r.carried) });
    });
  }
  function doDismiss() {
    startTransition(async () => {
      const r = await dismissDuplicateSuggestion(itemShortId);
      if (r.ok) router.refresh();
      else fail(r.error);
    });
  }
  function findSimilar() {
    startSearch(async () => {
      const r = await listDuplicateCandidates(itemShortId);
      setSearched(true);
      if (r.ok) setCandidates(r.candidates);
      else fail(r.error);
    });
  }

  // This item is a duplicate of another — show the link + unmerge only.
  if (merge.mergedInto) {
    return (
      <Card>
        <CardHead title="Duplicate" />
        <div className="card-body col gap-3">
          <p className="text-sm muted" style={{ margin: 0 }}>
            Merged into{" "}
            <Link href={`/thread/${merge.mergedInto.shortId}`} className="mono">{merge.mergedInto.shortId}</Link>
            {": "}{merge.mergedInto.title}
          </p>
          {canManage && (
            <Btn sm onClick={doUnmerge} disabled={pending}>{pending ? "Unmerging…" : "Unmerge"}</Btn>
          )}
        </div>
      </Card>
    );
  }

  // Nothing to show (self-host with no embeddings + no merges) → render nothing.
  const hasContent = merge.pendingSuggestion || merge.mergedCount > 0 || merge.dedupAvailable;
  if (!hasContent) return null;

  const mergeLabel = (other: string) => (swap ? `Merge ${other} here` : `Merge into ${other}`);
  const offersMerge = canManage && (!!merge.pendingSuggestion || (candidates?.length ?? 0) > 0);

  return (
    <Card>
      <CardHead title="Duplicates" />
      <div className="card-body col gap-3">
        {merge.mergedCount > 0 && (
          <div className="row gap-2 center" style={{ flexWrap: "wrap" }}>
            <Pill solid><Ic.copy style={{ width: 10, height: 10 }} />{merge.mergedCount} merged</Pill>
            {/* Same vocabulary as the inbox: revenue at stake across the
                distinct accounts asking (followers — people — kept as the
                secondary count). */}
            <span className="text-xs muted">
              {formatArr(merge.combinedArrCents)} at stake · {merge.accountCount} {merge.accountCount === 1 ? "account" : "accounts"}
              {merge.followerCount > merge.accountCount && ` · ${merge.followerCount} ${merge.followerCount === 1 ? "follower" : "followers"}`}
            </span>
          </div>
        )}

        {offersMerge && (
          <div className="row gap-2 center between" style={{ flexWrap: "wrap" }}>
            <span className="text-xs muted">
              {swap ? `The item you pick folds into ${itemShortId}.` : `${itemShortId} folds into the item you pick.`}
            </span>
            <Btn sm variant="ghost" aria-pressed={swap} onClick={() => setSwap(s => !s)} disabled={pending}>
              Swap direction
            </Btn>
          </div>
        )}

        {merge.pendingSuggestion && canManage && (
          <div className="col gap-2" style={{ padding: 10, border: "var(--border)", borderRadius: "var(--r-sm)", background: "var(--surface-2)" }}>
            <span className="text-sm row gap-2 center" style={{ flexWrap: "wrap" }}>
              <Ic.sparkle style={{ width: 11, height: 11, color: "var(--accent-deep)" }} />
              Likely duplicate of{" "}
              <Link href={`/thread/${merge.pendingSuggestion.candidateShortId}`} className="mono">{merge.pendingSuggestion.candidateShortId}</Link>
              <span className="text-xs muted">({Math.round(merge.pendingSuggestion.similarity * 100)}% match)</span>
            </span>
            <span className="text-xs muted truncate">{merge.pendingSuggestion.candidateTitle}</span>
            <div className="row gap-2" style={{ flexWrap: "wrap" }}>
              <Btn sm variant="primary" onClick={() => doMerge(merge.pendingSuggestion!.candidateShortId)} disabled={pending}>
                {mergeLabel(merge.pendingSuggestion.candidateShortId)}
              </Btn>
              <Btn sm onClick={doDismiss} disabled={pending}>Not a duplicate</Btn>
            </div>
          </div>
        )}

        {merge.dedupAvailable && canManage && (
          <>
            <Btn sm icon={<Ic.search style={{ width: 11, height: 11 }} />} onClick={findSimilar} disabled={pending || searching}>
              {searching ? "Searching…" : "Find similar items"}
            </Btn>
            {searched && candidates && candidates.length === 0 && (
              <span className="text-xs muted">No similar items found.</span>
            )}
            {candidates && candidates.length > 0 && (
              <div className="col gap-2">
                {candidates.map((c) => (
                  <div key={c.shortId} className="row gap-2 center between" style={{ minWidth: 0 }}>
                    <Link href={`/thread/${c.shortId}`} className="grow truncate" style={{ textDecoration: "none", color: "inherit", minWidth: 0 }}>
                      <span className="text-sm truncate"><span className="mono text-xs muted">{c.shortId}</span> {c.title}</span>
                    </Link>
                    <span className="text-2xs muted mono">{Math.round(c.similarity * 100)}%</span>
                    <Btn sm onClick={() => doMerge(c.shortId)} disabled={pending}>{mergeLabel(c.shortId)}</Btn>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
