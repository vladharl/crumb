import { describe, expect, it } from "vitest";
import { SHORTCUTS, triageAction } from "@/app/(app)/inbox/triage-keys";

// Inbox keyboard triage: the keys map to their actions, and never fire while
// typing, mid-composition, with a modifier held, or inside a menu, listbox or
// dialog. Targets are stand-ins with the few DOM fields the guard reads.

const body = { tagName: "BODY", closest: () => null };
const link = { tagName: "A", closest: () => null };
const key = (k: string, over: Partial<Parameters<typeof triageAction>[0]> = {}) =>
  triageAction({ key: k, metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, target: body, ...over });

describe("triageAction", () => {
  it("maps each shortcut to its action", () => {
    expect(["j", "ArrowDown", "k", "ArrowUp", "r", "s", "a", "x", "?"].map(k => key(k)))
      .toEqual(["next", "next", "prev", "prev", "reply", "menu", "assign", "select", "help"]);
    expect(key("x", { target: link })).toBe("select");
    // Enter is the focused title link's own; capitals and other keys are nothing.
    expect(key("Enter")).toBeNull();
    expect(key("J")).toBeNull();
    expect(key("toString")).toBeNull();
  });

  it("stays out of the way of modifiers, IME composition and handled keys", () => {
    expect(key("j", { metaKey: true })).toBeNull();
    expect(key("k", { ctrlKey: true })).toBeNull();
    expect(key("a", { altKey: true })).toBeNull();
    expect(key("r", { isComposing: true })).toBeNull();
    expect(key("ArrowDown", { defaultPrevented: true })).toBeNull();
  });

  it("never fires while typing in a field", () => {
    for (const target of [
      { tagName: "INPUT", type: "text" },
      { tagName: "INPUT" },
      { tagName: "INPUT", type: "search" },
      { tagName: "INPUT", type: "radio" },
      { tagName: "TEXTAREA" },
      { tagName: "SELECT" },
      { tagName: "DIV", isContentEditable: true },
    ]) expect(key("a", { target })).toBeNull();
    // A row's checkbox isn't a field you type in: x toggles it, j moves on.
    expect(key("x", { target: { tagName: "INPUT", type: "checkbox", closest: () => null } })).toBe("select");
  });

  it("leaves menus, listboxes and dialogs their own keys", () => {
    const inMenu = { tagName: "BUTTON", closest: (sel: string) => (sel.includes('[role="menu"]') ? {} : null) };
    expect(key("ArrowDown", { target: inMenu })).toBeNull();
    expect(key("s", { target: inMenu })).toBeNull();
  });

  it("lists every key in the cheat sheet", () => {
    const listed = SHORTCUTS.flatMap(s => s.keys);
    for (const k of ["j", "k", "↓", "↑", "Enter", "r", "s", "a", "x", "?", "Esc"]) expect(listed).toContain(k);
    for (const s of SHORTCUTS) expect(s.does).not.toMatch(/[–—]/);
  });
});
