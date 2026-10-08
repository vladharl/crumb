// Inbox keyboard triage: which key does what, and when a key is not a
// shortcut. Pure, so the guard is unit-tested; InboxTable runs the actions.

export type TriageAction = "next" | "prev" | "reply" | "menu" | "assign" | "select" | "help";

// Enter needs no entry: j/k focus a row's title link, and Enter opens a link.
const KEYS: ReadonlyMap<string, TriageAction> = new Map([
  ["j", "next"], ["ArrowDown", "next"],
  ["k", "prev"], ["ArrowUp", "prev"],
  ["r", "reply"],
  ["s", "menu"],
  ["a", "assign"],
  ["x", "select"],
  ["?", "help"],
]);

/** Every shortcut, in the cheat sheet's order. */
export const SHORTCUTS: ReadonlyArray<{ keys: string[]; does: string }> = [
  { keys: ["j", "↓"], does: "Next row" },
  { keys: ["k", "↑"], does: "Previous row" },
  { keys: ["Enter"], does: "Open the thread" },
  { keys: ["r"], does: "Reply in place" },
  { keys: ["s"], does: "Status and actions menu" },
  { keys: ["a"], does: "Assign to me" },
  { keys: ["x"], does: "Select or unselect the row" },
  { keys: ["Esc"], does: "Close a menu, the reply drawer or this list" },
  { keys: ["?"], does: "Show these shortcuts" },
];

type TargetLike = {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
};

type KeyLike = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  defaultPrevented: boolean;
  target: unknown;
};

// Inputs where a key types or picks something. Checkboxes and buttons don't.
const NOT_TYPING_INPUTS: ReadonlySet<string> = new Set(["checkbox", "button", "submit", "reset"]);

function isTyping(t: TargetLike): boolean {
  if (t.isContentEditable) return true;
  if (t.tagName === "TEXTAREA" || t.tagName === "SELECT") return true;
  return t.tagName === "INPUT" && !NOT_TYPING_INPUTS.has((t.type ?? "text").toLowerCase());
}

/**
 * The triage action a keydown means, or null. Never while typing in a field,
 * mid-IME composition, with Cmd, Ctrl or Alt held, or inside a menu, listbox
 * or dialog (those own their keys).
 */
export function triageAction(e: KeyLike): TriageAction | null {
  if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return null;
  const action = KEYS.get(e.key);
  if (!action) return null;
  const t = (e.target ?? null) as TargetLike | null;
  if (t && isTyping(t)) return null;
  if (t?.closest?.('[role="menu"], [role="listbox"], [role="dialog"]')) return null;
  return action;
}
