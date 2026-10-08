import * as React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dropdown, Field, Switch } from "@crumb/ui";
import { dropdownName, nextEnabled } from "../../../../packages/ui/src/dropdown";
import { wrapTab } from "@/components/Dialog";
import { toastClocks } from "@/components/toast";

// The accessibility primitives: the shared dialog's Tab wrap, toast clocks
// that pause, the Dropdown's name and arrow walk, and what the @crumb/ui
// atoms announce.

// The unit config compiles JSX to React.createElement without importing React.
const html = (el: React.ReactElement) => {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(el);
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Dialog wrapTab", () => {
  const stops = ["a", "b", "c"];

  it("wraps at the edges and leaves the middle to the browser", () => {
    expect(wrapTab(stops, "c", false)).toBe("a");
    expect(wrapTab(stops, "a", true)).toBe("c");
    expect(wrapTab(stops, "b", false)).toBeNull();
    expect(wrapTab(stops, "b", true)).toBeNull();
  });

  it("brings focus back in from the card itself, and keeps a lone control", () => {
    expect(wrapTab(stops, null, false)).toBe("a");
    expect(wrapTab(stops, "card", true)).toBe("c");
    expect(wrapTab(["close"], "close", false)).toBe("close");
    expect(wrapTab(["close"], "close", true)).toBe("close");
  });
});

describe("toastClocks", () => {
  it("stops while hovered or focused and resumes with the time it had left", () => {
    vi.useFakeTimers();
    const gone: number[] = [];
    const clocks = toastClocks(id => gone.push(id));
    clocks.start(1, 6000);
    vi.advanceTimersByTime(4000);

    clocks.hold(1, "hover", true);
    vi.advanceTimersByTime(60_000);
    clocks.hold(1, "focus", true);
    clocks.hold(1, "hover", false); // focus still holds it
    vi.advanceTimersByTime(60_000);
    expect(gone).toEqual([]);

    clocks.hold(1, "focus", false);
    vi.advanceTimersByTime(1999);
    expect(gone).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(gone).toEqual([1]);
  });

  it("never fires for a toast that was stopped", () => {
    vi.useFakeTimers();
    const gone: number[] = [];
    const clocks = toastClocks(id => gone.push(id));
    clocks.start(1, 1000);
    clocks.start(2, 1000);
    clocks.stop(1);
    vi.advanceTimersByTime(1000);
    expect(gone).toEqual([2]);
  });
});

describe("Dropdown", () => {
  it("names the trigger by its label and value", () => {
    expect(dropdownName("Status", "In review", "Select…")).toBe("Status: In review");
    expect(dropdownName("Assignee", null, "Unassigned")).toBe("Assignee: Unassigned");
    // A placeholder that only restates the label isn't said twice.
    expect(dropdownName("Set status", null, "Set status…")).toBe("Set status");
    expect(dropdownName("HubSpot field that holds ARR", null, "Field that holds ARR")).toBe("HubSpot field that holds ARR");
    expect(dropdownName(undefined, "In review", "Select…")).toBeUndefined();
  });

  it("walks enabled rows only and stops at the ends", () => {
    const rows = [{ disabled: true }, {}, { disabled: true }, {}];
    expect(nextEnabled(rows, -1, 1)).toBe(1); // Home
    expect(nextEnabled(rows, rows.length, -1)).toBe(3); // End
    expect(nextEnabled(rows, 1, 1)).toBe(3);
    expect(nextEnabled(rows, 3, 1)).toBe(3);
    expect(nextEnabled(rows, 1, -1)).toBe(1);
    expect(nextEnabled([{ disabled: true }], -1, 1)).toBe(-1);
  });

  it("puts the value in the trigger's accessible name", () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // the SSR useLayoutEffect notice
    const out = html(React.createElement(Dropdown, {
      ariaLabel: "Status",
      value: "review",
      onChange: () => {},
      options: [{ value: "open", label: "Open" }, { value: "review", label: "In review" }],
    }));
    expect(out).toContain('aria-label="Status: In review"');
    expect(out).toContain('aria-haspopup="listbox"');
    expect(out).toContain('aria-expanded="false"');
  });
});

describe("@crumb/ui atoms", () => {
  it("Switch is a named on/off switch that can be disabled", () => {
    const out = html(React.createElement(Switch, { on: true, label: "Email digest", disabled: true }));
    expect(out).toContain('role="switch"');
    expect(out).toContain('aria-checked="true"');
    expect(out).toContain('aria-label="Email digest"');
    expect(out).toMatch(/<button[^>]* disabled=""/);
    expect(html(React.createElement(Switch, {}))).toContain('aria-checked="false"');
  });

  it("Switch draws its on track on the page, and its white knob on that track, at 3:1", () => {
    const css = readFileSync(resolve(__dirname, "../../app/globals.css"), "utf8");
    const root = /:root \{([\s\S]*?)\n\}/.exec(css)![1]!;
    const color = (v: string): string => {
      const ref = /^var\((--[\w-]+)\)$/.exec(v.trim());
      if (ref) return color(new RegExp(`${ref[1]}:\\s*([^;]+);`).exec(root)![1]!);
      return v.trim() === "white" ? "#FFFFFF" : v.trim();
    };
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [lum(color(a)), lum(color(b))].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const track = /\n\.switch\.on \{ background: ([^;]+);/.exec(css)![1]!;
    const knob = /\n\.switch\.on::after \{[^}]*background: ([^;]+);/.exec(css)![1]!;
    expect(contrast(track, "var(--bg)")).toBeGreaterThanOrEqual(3);
    expect(contrast(knob, track)).toBeGreaterThanOrEqual(3);
  });

  it("Field ties its label to a lone input", () => {
    const tied = (out: string) => [out.match(/<label[^>]*for="([^"]+)"/)?.[1], out.match(/<input[^>]*id="([^"]+)"/)?.[1]];

    const [forId, inputId] = tied(html(React.createElement(Field, { label: "Email" }, React.createElement("input", { name: "email" }))));
    expect(forId).toBeTruthy();
    expect(forId).toBe(inputId);

    expect(tied(html(React.createElement(Field, { label: "Email" }, React.createElement("input", { id: "own" })))))
      .toEqual(["own", "own"]);
    expect(html(React.createElement(Field, { label: "Role" }, React.createElement("div", null, "x")))).not.toContain("for=");
  });
});
