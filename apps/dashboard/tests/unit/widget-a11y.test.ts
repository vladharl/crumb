import { beforeAll, describe, expect, it, vi } from "vitest";
import { css } from "../../../widget/src/styles";

// The widget's accessibility floor (audits #69, #74, #70): text contrast on
// every panel surface, the tablist's keys, the launcher's name, and the phone
// sheet. Focus handling and the dialog itself are DOM work, checked in a browser.

let w: typeof import("../../../widget/src/widget");
beforeAll(async () => {
  // widget.ts looks for its <script> tag at load; node has none, so it stops after the stub.
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { currentScript: null, scripts: [] });
  w = await import("../../../widget/src/widget");
});

type RGBA = [number, number, number, number];
const parse = (c: string): RGBA => {
  const hex = /^#([0-9a-f]{6})$/i.exec(c.trim().replace(/^#(\w)(\w)(\w)$/, "#$1$1$2$2$3$3"));
  if (hex) return [0, 2, 4].map(i => parseInt(hex[1]!.slice(i, i + 2), 16)).concat(1) as RGBA;
  const rgba = /^rgba\(([^)]+)\)$/.exec(c.trim());
  if (!rgba) throw new Error(`unparsed color ${c}`);
  return rgba[1]!.split(",").map(Number) as RGBA;
};
const token = (name: string) => parse(new RegExp(`${name}:\\s*([^;]+);`).exec(css)![1]!);
const over = (top: RGBA, bg: RGBA): RGBA => [0, 1, 2].map(i => top[i]! * top[3] + bg[i]! * (1 - top[3])).concat(1) as RGBA;
const luminance = (c: RGBA) => {
  const [r, g, b] = c.slice(0, 3).map(v => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: RGBA, b: RGBA) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("widget text contrast (WCAG AA, 4.5:1)", () => {
  const bg = token("--c-bg");
  const surface2 = token("--c-surface-2");
  const surfaces = {
    bg,
    "surface-2": surface2,
    "ember wash on bg": over(token("--c-accent-soft"), bg),
    "ember wash on surface-2": over(token("--c-accent-soft"), surface2),
  };

  it("passes on every panel surface for each text token", () => {
    for (const name of ["--c-ink", "--c-ink-2", "--c-accent-ink", "--c-rust-deep"]) {
      for (const [where, surface] of Object.entries(surfaces)) {
        expect(contrast(token(name), surface), `${name} on ${where}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("passes for error text on its wash and for placeholders on the input fill", () => {
    const errWash = parse(/\.err \{[^}]*background: (rgba\([^)]+\))/.exec(css)![1]!);
    expect(contrast(token("--c-rust-deep"), over(errWash, bg))).toBeGreaterThanOrEqual(4.5);
    const placeholder = parse(/::placeholder \{ color: ([^;]+);/.exec(css)![1]!);
    expect(contrast(over(placeholder, bg), bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("passes for the vendor's initials on their avatar", () => {
    const [, fill, ink] = /\.msg\.vendor \.avatar \{ background: var\(([^)]+)\); color: ([^;]+);/.exec(css)!;
    expect(contrast(token(fill!), parse(ink!))).toBeGreaterThanOrEqual(4.5);
  });

  it("never sets text in warm gray (3.3:1), which is for status dots only", () => {
    expect(contrast(token("--c-ink-3"), surface2)).toBeLessThan(4.5); // why the rule exists
    expect(css).not.toMatch(/(^|[^-])color:\s*var\(--c-ink-3\)/m);
  });
});

describe("widget non-text contrast (WCAG 1.4.11, 3:1)", () => {
  const bg = token("--c-bg");
  // A rule's color as painted on the panel, with a brand var read as its
  // fallback (an unbranded install); readableAccent's 4.5:1 against white
  // covers a brand.
  const value = (rule: RegExp) => {
    const v = rule.exec(css)![1]!;
    const ref = /--c-[\w-]+(?=\)+$)/.exec(v);
    return over(ref ? token(ref[0]) : parse(v), bg);
  };

  it("draws switch tracks and their knob, off and on, at 3:1", () => {
    const off = value(/\n\.sw \{[^}]*background: ([^;]+);/);
    const on = value(/\n\.sw\.on \{ background: ([^;]+);/);
    const knob = value(/\n\.sw::after \{[^}]*background: ([^;]+);/);
    for (const [name, track] of Object.entries({ off, on })) {
      expect(contrast(track, bg), `${name} track`).toBeGreaterThanOrEqual(3);
      expect(contrast(knob, track), `knob on the ${name} track`).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps a focused field's border at 3:1, since it replaces the focus ring", () => {
    const focus = /input\.field:focus, textarea\.field:focus \{[^}]*\}/.exec(css)![0];
    expect(focus).toMatch(/outline: none;/);
    expect(contrast(value(/field:focus \{[^}]*border-color: ([^;]+);/), bg)).toBeGreaterThanOrEqual(3);
    // The lightest brand the panel takes (white on it at 4.5:1) clears it too.
    expect(w.readableAccent("#767676")).toBe("#767676");
    expect(contrast(parse("#767676"), bg)).toBeGreaterThanOrEqual(3);
  });
});

describe("tablist keys", () => {
  it("arrows wrap, Home/End jump, anything else is left alone", () => {
    expect(w.tabStep("ArrowRight", 0, 3)).toBe(1);
    expect(w.tabStep("ArrowRight", 2, 3)).toBe(0);
    expect(w.tabStep("ArrowLeft", 0, 3)).toBe(2);
    expect(w.tabStep("Home", 2, 3)).toBe(0);
    expect(w.tabStep("End", 0, 3)).toBe(2);
    expect(w.tabStep("Enter", 1, 3)).toBe(-1);
    expect(w.tabStep("ArrowDown", 1, 3)).toBe(-1);
  });
});

describe("launcher name", () => {
  it("starts with its visible label and carries the unread count", () => {
    expect(w.launcherLabel(0)).toBe("Feedback");
    expect(w.launcherLabel(1)).toBe("Feedback, 1 update");
    expect(w.launcherLabel(3)).toBe("Feedback, 3 updates");
  });
});

describe("phones", () => {
  it("open as a full-height sheet, with 16px fields on touch screens", () => {
    const sheet = css.slice(css.indexOf("@media (max-width: 479px)"));
    expect(sheet).toMatch(/height: 100vh; height: 100dvh;/); // dvh wins where supported
    expect(sheet).toMatch(/safe-area-inset-bottom/);
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*input\.field, textarea\.field \{ font-size: 16px; \}/);
  });
});
