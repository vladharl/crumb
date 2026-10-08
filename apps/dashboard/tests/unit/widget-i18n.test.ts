import { afterEach, describe, expect, it } from "vitest";
import { LOCALES, en, pickLocale, timeFormat } from "../../../widget/src/strings";

// The widget in the customer's language (audit #78): one typed table with
// English complete, the locale taken from data-locale, then <html lang>, then
// the browser, and times written in that locale.

describe("locale", () => {
  afterEach(() => { delete LOCALES.fr; });

  it("takes the first tag it has words for, and dates follow that tag", () => {
    expect(pickLocale(["en-GB", "en-US"]).locale).toBe("en-GB");       // data-locale first
    expect(pickLocale([undefined, "", "en-AU"]).locale).toBe("en-AU");  // then the page, then the browser
    expect(pickLocale(["de-DE", "en-CA"]).locale).toBe("en-CA");        // no German yet: the next tag
    expect(pickLocale(["en_US"]).locale).toBe("en-US");                 // underscores read as BCP 47
    expect(pickLocale(["not a tag", "x", null]).locale).toBe("en");     // nothing usable
    // A page in a language we lack: English words and English dates, never a mix.
    expect(pickLocale(["de", "ja-JP"])).toEqual({ locale: "en", t: en });
  });

  it("adds a language with one entry, and a key it lacks stays English", () => {
    LOCALES.fr = { feedback: "Avis", updates: (n: number) => `${n} nouveautés` };
    const { locale, t } = pickLocale(["fr-CA"]);
    expect(locale).toBe("fr-CA");
    expect([t.feedback, t.updates(2)]).toEqual(["Avis", "2 nouveautés"]);
    expect([t.send, t.statuses.shipped, t.replies(1)]).toEqual(["Send", "Shipped", "1 reply"]);
  });

  it("keeps every string plain text that's safe in an attribute, with no em-dashes", () => {
    const texts = (v: unknown): string[] =>
      typeof v === "string" ? [v]
      : typeof v === "function" ? [(v as (...a: unknown[]) => string)(2, "x")]
      : Object.values(v as object).flatMap(texts);
    for (const [tag, table] of Object.entries(LOCALES)) {
      for (const s of texts(table)) expect(s, `${tag}: ${s}`).not.toMatch(/[<>&"\u2014]/);
    }
  });
});

describe("times", () => {
  const now = new Date(2026, 9, 7, 9, 30); // Wednesday 7 Oct 2026, 9:30 local
  const ago = (d: Date, locale = "en") => timeFormat(locale).ago(d.toISOString(), now);

  it("reads relative, then by calendar day, then as a date", () => {
    expect(ago(new Date(2026, 9, 7, 9, 29, 40))).toBe("now");
    expect(ago(new Date(2026, 9, 7, 9, 45))).toBe("now"); // a server clock running ahead
    expect(ago(new Date(2026, 9, 7, 9, 25))).toBe("5 minutes ago");
    expect(ago(new Date(2026, 9, 6, 23, 0))).toBe("10 hours ago");
    expect(ago(new Date(2026, 9, 6, 8, 0))).toBe("yesterday");
    expect(ago(new Date(2026, 9, 5, 23, 0))).toBe("2 days ago"); // Monday night: 34.5h, but two days back
    expect(ago(new Date(2026, 9, 1, 12, 0))).toBe("6 days ago");
    expect(ago(new Date(2026, 8, 30, 12, 0))).toBe("Sep 30");
    expect(ago(new Date(2025, 8, 16, 12, 0))).toBe("Sep 16, 2025");
    expect(timeFormat("en").ago("", now)).toBe("");
    expect(timeFormat("en").exact("not a date")).toBe("");
  });

  it("writes them in the widget's locale", () => {
    const d = new Date(2026, 8, 16, 14, 5);
    expect(ago(d, "en-GB")).toBe(new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric" }).format(d));
    expect(ago(d, "en-GB")).not.toBe(ago(d, "en-US")); // "16 Sept", not "Sep 16"
    expect(timeFormat("en-US").exact(d.toISOString())).toMatch(/^September 16, 2026.* 2:05\sPM$/);
  });
});
