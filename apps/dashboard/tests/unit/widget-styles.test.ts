import { describe, expect, it } from "vitest";
import { css, minifyCss } from "../../../widget/src/styles";

// The widget's stylesheet (audit #79): minified at build time (build.mjs)
// without changing what it says, and held to DESIGN.md's tokens.

describe("minifyCss", () => {
  it("drops comments and spare whitespace, never inside a string or url()", () => {
    expect(minifyCss(`
      /* note */ .a  >  .b ,
      .c :hover { color : red ; margin: 0 auto; }
      .d::after { content: "a  /* b */  c"; background: url(data:image/svg+xml;utf8,a/*b*/c) }
      @media (max-width: 479px) and (pointer: coarse) { .e { width: calc(100% - 8px); } }
    `)).toBe(
      `.a > .b,.c :hover{color:red;margin:0 auto;}` +
      `.d::after{content:"a  /* b */  c";background:url(data:image/svg+xml;utf8,a/*b*/c)}` +
      `@media (max-width:479px) and (pointer:coarse){.e{width:calc(100% - 8px);}}`,
    );
  });

  it("keeps every rule and declaration of the real stylesheet", () => {
    const min = minifyCss(css);
    for (const ch of ["{", "}", ";", "(", '"']) expect(min.split(ch).length, ch).toBe(css.split(ch).length);
    expect(min).not.toMatch(/\/\*|\n| {2}/);
    expect(min.length).toBeLessThan(css.length * 0.9);
  });
});

describe("design tokens", () => {
  it("shadows are warm brown, never black or a cold gray", () => {
    expect(css).not.toMatch(/rgba\(\s*(0,\s*0,\s*0|20,\s*22,\s*27)\b/);
  });

  it("corners are radius tokens on the 4 to 10px scale, pills, or square", () => {
    const corner = String.raw`(?:var\(--r-(?:md|lg|xl)\)|0)`;
    for (const [, v] of css.matchAll(/border-radius:\s*([^;]+);/g)) {
      expect(v).toMatch(new RegExp(`^(?:999px|${corner}(?: ${corner})*)$`));
    }
    const radii = [...css.matchAll(/--r-\w+:\s*(\d+)px/g)].map(m => Number(m[1]));
    expect(radii.length).toBeGreaterThan(0);
    for (const px of radii) expect(px >= 4 && px <= 10, `${px}px`).toBe(true);
  });

  it("the primary button stays flat on hover, and loading shimmers cream-2 to cream-soft", () => {
    const hovers = css.match(/button\.primary:hover[^{]*\{[^}]*\}/g) ?? [];
    expect(hovers.length).toBeGreaterThan(0);
    for (const rule of hovers) expect(rule).not.toMatch(/box-shadow|transform/);
    expect(css).toMatch(/\.skel \{[^}]*var\(--c-surface-2\) 30%, #FDFAF4 50%/);
  });
});
