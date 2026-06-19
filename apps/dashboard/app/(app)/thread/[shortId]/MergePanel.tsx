"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Btn, Card, CardHead, Ic, Pill } from "@crumb/ui";
import {
  mergeItems,
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

function mergeErrorText(e: string): string {
  switch (e) {
    case "source_has_duplicates": return "That item already has duplicates merged into it. Unmerge those first.";
    case "target_is_duplicate":   return "Can't merge into an item that's already a duplicate.";
    case "same_item":             return "Can't merge an item into itself.";
    case "forbidden":             return "You don't have permission to merge.";
    case "not_found":             return "That item no longer exists.";
    default:                      return "Something went wrong. Try again.";
  }
}

export function MergePanel({
  itemShortId, canManage, merge,
}: {
  itemShortId: string;
  canManage: boolean;
  merge: ThreadMergeData;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [candidates, setCandidates] = useState<DuplicateCandidateView[] | null>(null);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function doMerge(sourceShortId: string, targetShortId: string) {
    setError(null);
    startTransition(async () => {
      const r = await mergeItems(sourceShortId, targetShortId);
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  }
  function doUnmerge() {
    setError(null);
    startTransition(async () => {
      const r = await unmergeItem(itemShortId);
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  }
  function doDismiss() {
    startTransition(async () => {
      const r = await dismissDuplicateSuggestion(itemShortId);
      if (r.ok) router.refresh();
    });
  }
  function findSimilar() {
    setError(null);
    startTransition(async () => {
      const r = await listDuplicateCandidates(itemShortId);
      setSearched(true);
      if (r.ok) setCandidates(r.candidates);
      else setError(r.error);
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
              <Btn sm variant="primary" onClick={() => doMerge(itemShortId, merge.pendingSuggestion!.candidateShortId)} disabled={pending}>
                Merge into {merge.pendingSuggestion.candidateShortId}
              </Btn>
              <Btn sm onClick={doDismiss} disabled={pending}>Not a duplicate</Btn>
            </div>
          </div>
        )}

        {merge.dedupAvailable && canManage && (
          <>
            <Btn sm icon={<Ic.search style={{ width: 11, height: 11 }} />} onClick={findSimilar} disabled={pending}>
              {pending && !searched ? "Searching…" : "Find similar items"}
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
                    <Btn sm onClick={() => doMerge(c.shortId, itemShortId)} disabled={pending}>Merge in</Btn>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {error && <span className="text-xs" style={{ color: "var(--err-text)" }}>{mergeErrorText(error)}</span>}
      </div>
    </Card>
  );
}
