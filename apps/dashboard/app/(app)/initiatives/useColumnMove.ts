import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { runAction, sendAfterDelay, STATUS_EMAIL_DELAY_MS } from "@/components/ReplyComposer";
import { useToast } from "@/components/toast";
import { moveInitiative } from "./actions";
import type { BoardCol } from "./InitiativesBoard";

const COLUMN_LABEL: Record<BoardCol, string> = { now: "Now", next: "Next", later: "Later" };

// A public initiative landing in another roadmap column emails its followers
// (reorderInitiatives), so that move waits behind an Undo toast first. Shared
// by a drop on the board and the edit panel's Column control. Unscheduling
// emails no one, so callers only ask about Now, Next and Later.
export function moveEmailsFollowers(
  card: { column: BoardCol | null; isPublic: boolean; followers: number },
  target: BoardCol,
): boolean {
  return card.isPublic && card.followers > 0 && target !== card.column;
}

export const movedMessage = (target: BoardCol) =>
  `Moved to ${COLUMN_LABEL[target]}. Emailing its followers in ${STATUS_EMAIL_DELAY_MS / 1000} seconds.`;
export const MOVE_UNDONE = "Undone. Its followers weren't emailed.";

/**
 * The edit panel's Column control, so an initiative moves without a drag. A
 * move that emails its followers shows at once but waits STATUS_EMAIL_DELAY_MS
 * behind an Undo toast before it's saved, like a drop on the board. Other
 * moves save right away. The latest pick wins, a failed save rolls back and
 * says why, and a waiting move saves at once when the page is hidden or left.
 */
export function useColumnMove({ id, column, isPublic, followers, onSaved }: {
  id: string;
  column: BoardCol | null; // the server's column; null is Unscheduled
  isPublic: boolean;
  followers: number;
  onSaved?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  // undefined while showing the server's column.
  const [optimistic, setOptimistic] = useState<BoardCol | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const waiting = useRef<{ undo: () => boolean; flush: () => void; toastId: number } | null>(null);

  // The refreshed server column caught up: retire the overlay.
  useEffect(() => { setOptimistic(o => (o === column ? undefined : o)); }, [column]);

  // Leaving the page saves a waiting move now, rather than on a timer nothing
  // is left to undo it from.
  useEffect(() => () => waiting.current?.flush(), []);

  // Drops the move waiting to save, if any; true when it stopped in time.
  function dropWaiting(): boolean {
    const w = waiting.current;
    if (!w) return false;
    waiting.current = null;
    toast.dismiss(w.toastId);
    return w.undo();
  }

  async function commit(next: BoardCol | null) {
    setSaving(true);
    const res = await runAction(toast, () => moveInitiative(id, next));
    setSaving(false);
    if (!res) { setOptimistic(undefined); return; }
    onSaved?.();
    router.refresh();
  }

  function move(next: BoardCol | null) {
    // The latest pick wins: a move still waiting never saves.
    const undone = dropWaiting();
    const emails = next !== null && moveEmailsFollowers({ column, isPublic, followers }, next);
    if (undone && !emails) toast.show({ message: MOVE_UNDONE });
    // Back where the server has it: nothing to save.
    if (next === column) { setOptimistic(undefined); return; }
    setOptimistic(next);
    if (!emails) { void commit(next); return; }

    const pending = sendAfterDelay(() => {
      // Saving, on time or early: Undo is over.
      const w = waiting.current;
      waiting.current = null;
      if (w) toast.dismiss(w.toastId);
      void commit(next);
    }, STATUS_EMAIL_DELAY_MS);
    const toastId = toast.show({
      message: movedMessage(next),
      duration: STATUS_EMAIL_DELAY_MS,
      action: {
        label: "Undo",
        onClick: () => {
          if (waiting.current?.toastId !== toastId || !dropWaiting()) return;
          setOptimistic(undefined);
          toast.show({ message: MOVE_UNDONE });
        },
      },
    });
    waiting.current = { ...pending, toastId };
  }

  return { shown: optimistic === undefined ? column : optimistic, saving, move };
}
