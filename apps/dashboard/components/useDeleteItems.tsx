"use client";

import { useEffect, useRef } from "react";
import { useConfirm } from "@/components/confirm";
import { useToast } from "@/components/toast";
import { cancelWaitingMove, runAction, sendAfterDelay, STATUS_EMAIL_DELAY_MS } from "@/components/ReplyComposer";
import { errorMessage } from "@/lib/action-error";
import { deleteItems } from "@/app/(app)/items/delete-actions";

type Mode = "delete" | "spam";
type Target = { shortId: string; title: string };

export type DeleteItemsOptions = {
  onHidden?: (shortIds: string[]) => void;
  onRestored?: (shortIds: string[]) => void;
  onDeleted?: (shortIds: string[]) => void;
};

// The server's cap (DELETE_MAX, lib/items/delete.ts), checked here first so a
// bigger selection is turned down before anything disappears.
const DELETE_MAX = 50;

// What goes, what spam does on top, and that nobody hears about it.
function confirmCopy(list: Target[], mode: Mode) {
  const n = list.length;
  const one = n === 1;
  const named = one ? `“${list[0]!.title}”` : `These ${n} requests`;
  if (mode === "spam") {
    return {
      title: one ? "Mark this as spam?" : `Mark ${n} requests as spam?`,
      body: `${named} will be deleted for good, and ${one ? "its submitter is" : "their submitters are"} blocked: new feedback and email replies from them are turned away. Nobody is emailed. You can undo right after.`,
      confirmLabel: "Mark as spam",
    };
  }
  return {
    title: one ? "Delete this request?" : `Delete ${n} requests?`,
    body: `${named} and ${one ? "its conversation" : "their conversations"} will be deleted for good. ${one ? "It stops" : "They stop"} counting toward ARR and Insights, and nobody is emailed. You can undo right after.`,
    confirmLabel: one ? "Delete" : `Delete ${n}`,
  };
}

function hiddenMessage(n: number, mode: Mode): string {
  if (mode === "spam") return n === 1 ? "Marked as spam." : `${n} requests marked as spam.`;
  return n === 1 ? "Request deleted." : `${n} requests deleted.`;
}

/**
 * Delete or Mark as spam for a selection of items. Admins only: callers show
 * the entry to admins alone, and the server checks again. Confirms first,
 * then hides the rows (onHidden) behind an Undo toast and commits only once
 * the toast is over (onDeleted), like a status email (useStatusMove). Undo, or
 * a failed commit, brings them back (onRestored). A waiting delete commits at
 * once when the page is hidden or the calling component unmounts, so a caller
 * that navigates away in onHidden gives up the Undo: navigate in onDeleted
 * (the commit re-renders the current page, so a thread shows not found first).
 */
export function useDeleteItems(
  opts?: DeleteItemsOptions,
): (items: Array<{ shortId: string; title: string }>, mode: "delete" | "spam") => void {
  const toast = useToast();
  const confirm = useConfirm();
  const callbacks = useRef(opts);
  callbacks.current = opts;
  // The flush of each delete still inside its Undo window.
  const waiting = useRef(new Set<() => void>());

  // Leaving commits a waiting delete now, rather than on a timer nothing is
  // left to undo it from.
  useEffect(() => {
    const flushes = waiting.current;
    return () => { for (const flush of [...flushes]) flush(); };
  }, []);

  // The action revalidates every page, so its answer carries the current one
  // already refreshed: no router.refresh() here.
  async function commit(shortIds: string[], mode: Mode, n: number) {
    const res = await runAction(toast, () => deleteItems(shortIds, mode));
    if (!res) { callbacks.current?.onRestored?.(shortIds); return; }
    callbacks.current?.onDeleted?.(shortIds);
    const k = res.restored;
    if (k > 0) {
      toast.show({ message: `Unmerged ${k} ${k === 1 ? "request that was" : "requests that were"} merged into ${n === 1 ? "it" : "them"}.` });
    }
  }

  async function run(list: Target[], mode: Mode) {
    if (list.length === 0) return;
    if (list.length > DELETE_MAX) {
      toast.show({ message: errorMessage("too_many_items"), tone: "error" });
      return;
    }
    if (!(await confirm({ ...confirmCopy(list, mode), destructive: true }))) return;

    const shortIds = list.map(i => i.shortId);
    // A status email still waiting about one of these never goes out. Before
    // hiding, since that can unmount the control that would send it.
    for (const shortId of shortIds) cancelWaitingMove(shortId);
    callbacks.current?.onHidden?.(shortIds);

    let toastId = 0;
    const pending = sendAfterDelay(() => {
      // Committing, on time or early (page hidden or left): Undo is over.
      waiting.current.delete(pending.flush);
      toast.dismiss(toastId);
      void commit(shortIds, mode, list.length);
    }, STATUS_EMAIL_DELAY_MS);
    waiting.current.add(pending.flush);
    toastId = toast.show({
      message: hiddenMessage(list.length, mode),
      duration: STATUS_EMAIL_DELAY_MS,
      action: {
        label: "Undo",
        onClick: () => {
          if (!pending.undo()) return;
          waiting.current.delete(pending.flush);
          callbacks.current?.onRestored?.(shortIds);
          toast.show({ message: mode === "spam" ? "Undone. Nothing was deleted and nobody was blocked." : "Undone. Nothing was deleted." });
        },
      },
    });
  }

  return (list, mode) => { void run(list, mode); };
}
