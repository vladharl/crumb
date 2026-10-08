"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import { Btn, Card, CardHead, Field, Pill } from "@crumb/ui";
import { saveBranding, fetchSitePreview } from "./actions";

type Edge = "right" | "left";
// "auto" is Shown. The widget also accepts "always" (same behaviour), which
// workspaces may have saved; page.tsx shows it as Shown and a save writes "auto".
type Visibility = "auto" | "hidden";
type PreviewState = "rest" | "news" | "peek";

// WCAG-style relative-luminance contrast ratio between two hex colors.
// Returns 1.0 (identical) → 21.0 (black-on-white). We warn under 3.0.
function contrastRatio(a: string, b: string): number {
  const L = (hex: string) => {
    const c = hex.replace("#", "");
    if (c.length !== 6) return 0.5;
    const ch = (n: number) => {
      const v = parseInt(c.slice(n, n + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
  };
  const l1 = L(a), l2 = L(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const SkelTile = ({ h = 28 }: { h?: number }) => (
  <div style={{
    border: "var(--border)",
    borderRadius: "var(--r-sm)",
    height: h,
    background: "transparent",
  }} />
);

// The same loop mark the widget mounts in its launcher tab.
function LoopMark({ dotColor, size = 16 }: { dotColor: string; size?: number }) {
  return (
    <svg viewBox="-5 -5 42 42" aria-hidden="true" style={{ width: size, height: size, overflow: "visible" }}>
      <circle cx="16" cy="3"  r="2.6" opacity="0.30" fill={dotColor} />
      <circle cx="28" cy="11" r="3.1" opacity="0.46" fill={dotColor} />
      <circle cx="28" cy="22" r="3.6" opacity="0.62" fill={dotColor} />
      <circle cx="17" cy="29" r="4.1" opacity="0.80" fill={dotColor} />
      <circle cx="4"  cy="22" r="4.6" opacity="0.95" fill={dotColor} />
    </svg>
  );
}

function BrandingPreview({
  dotColor, launcherBg, edge, offsetY, visibility, initialSite,
}: {
  dotColor: string; launcherBg: string; edge: Edge; offsetY: number; visibility: Visibility; initialSite: string;
}) {
  // Peek (the hover flag) can't be hovered in a static preview, so the three
  // launcher states are a toggle instead.
  const [state, setState] = useState<PreviewState>("news");
  const showDot = state !== "rest";
  const showFlag = state === "peek";

  // Live site preview: type a URL → the server fetches the real page and we
  // render it in a fully-sandboxed iframe behind the tab, scaled down from a
  // desktop viewport so it reads like a screenshot. Empty/unreachable → the
  // skeleton mock.
  const [siteInput, setSiteInput] = useState(initialSite);
  const [siteHtml, setSiteHtml] = useState<string | null>(null);
  const [siteState, setSiteState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [siteError, setSiteError] = useState<string | null>(null);
  const [siteThin, setSiteThin] = useState(false);
  const loadedFor = useRef<string | null>(null);

  function loadSite(raw: string) {
    const v = raw.trim();
    if (!v) {
      loadedFor.current = null;
      setSiteHtml(null);
      setSiteState("idle");
      setSiteError(null);
      return;
    }
    if (loadedFor.current === v && siteState === "loaded") return;
    loadedFor.current = v;
    setSiteState("loading");
    setSiteError(null);
    void fetchSitePreview(v).then(res => {
      if (loadedFor.current !== v) return; // a newer request superseded this one
      if (res.ok) {
        setSiteHtml(res.html);
        setSiteThin(res.thin);
        setSiteState("loaded");
      } else {
        setSiteHtml(null);
        setSiteState("error");
        setSiteError(res.error);
      }
    });
  }

  // The workspace's Product URL is the obvious site to show — load it once on
  // mount when set.
  useEffect(() => {
    if (initialSite) loadSite(initialSite);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scale a desktop-width render down to the pane.
  const SITE_W = 1280;
  const paneRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const update = () => setPane({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = pane.w > 0 ? pane.w / SITE_W : 0.4;

  return (
    <div
      style={{
        border: "var(--border)",
        borderRadius: "var(--r-sm)",
        background: "var(--bone)",
        position: "relative",
        overflow: "hidden",
        minHeight: 280,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{
        padding: "8px 14px",
        borderBottom: "var(--border)",
        fontSize: "var(--fs-2xs)",
        letterSpacing: "var(--ls-eyebrow)",
        textTransform: "uppercase",
        color: "var(--mute)",
        fontWeight: 500,
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}>
        <span style={{ width: 4, height: 4, borderRadius: 999, background: "var(--ink)", opacity: 0.4 }} />
        Your product · live preview
        <span style={{ flex: 1 }} />
        <div className="seg" style={{ textTransform: "none", letterSpacing: 0 }}>
          {([
            { k: "rest", label: "Rest" },
            { k: "news", label: "News" },
            { k: "peek", label: "Peek" },
          ] as const).map(({ k, label }) => (
            <button key={k} aria-selected={state === k} aria-pressed={state === k} onClick={() => setState(k)}>{label}</button>
          ))}
        </div>
      </div>

      {/* The frame's "address bar": editable; Enter or leaving the field pulls
          the real site behind the tab. */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "8px 14px",
        borderBottom: "var(--border)",
      }}>
        <span style={{
          width: 6, height: 6, borderRadius: 999, flexShrink: 0,
          background: siteState === "loaded" ? "var(--green)" : "var(--ink)",
          opacity: siteState === "loaded" ? 0.9 : 0.55,
        }} />
        <input
          className="text-2xs mono"
          value={siteInput}
          onChange={e => setSiteInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          onBlur={() => loadSite(siteInput)}
          placeholder="Type a URL like yourproduct.com to preview the tab on your real site"
          spellCheck={false}
          aria-label="Site to preview"
          style={{
            flex: 1, minWidth: 0,
            background: "transparent", border: 0,
            color: "var(--ink)", letterSpacing: "0.03em",
            padding: 0,
          }}
        />
        {siteState === "loading" && <span className="text-2xs" style={{ color: "var(--mute)", flexShrink: 0 }}>Fetching…</span>}
        {siteState === "error" && <span className="text-2xs" style={{ color: "var(--rust)", flexShrink: 0 }}>{siteError}</span>}
        {siteState === "loaded" && siteThin && (
          <span className="text-2xs" style={{ color: "var(--mute)", flexShrink: 0 }}>
            JS apps may stay blank without sign-in; try a public page
          </span>
        )}
      </div>

      <div ref={paneRef} style={{ position: "relative", flex: 1, padding: siteState === "loaded" ? 0 : 14, minHeight: 240, overflow: "hidden" }}>
        {siteState === "loaded" && siteHtml !== null ? (
          // allow-scripts (and nothing else): JS-rendered sites get to mount,
          // but the document keeps an opaque origin with no parent access,
          // and pointer-events keep it inert.
          <iframe
            title="Site preview"
            sandbox="allow-scripts"
            srcDoc={siteHtml}
            style={{
              position: "absolute", top: 0, left: 0,
              width: SITE_W,
              height: scale > 0 ? Math.ceil(pane.h / scale) : 0,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
              border: 0,
              background: "#fff",
              pointerEvents: "none",
            }}
          />
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <SkelTile />
              <SkelTile />
            </div>
            <SkelTile h={56} />
            <div style={{ height: 12 }} />
            <SkelTile h={42} />
          </>
        )}

        {/* The whisper tab, docked to the chosen edge of the preview frame —
            floats above the site iframe like the real widget does. The
            vertical nudge applies as on the live tab, clamped so an offset
            sized for a full viewport can't push it out of this small pane. */}
        {visibility !== "hidden" && (
        <div className="preview-launcher" data-edge={edge} style={{
          ["--lb" as string]: launcherBg,
          position: "absolute",
          zIndex: 1,
          ...(edge === "right" ? { right: 0 } : { left: 0 }),
          top: `clamp(56px, calc(50% + ${offsetY}px), calc(100% - 56px))`,
          transform: "translateY(-50%)",
          display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
          width: showDot ? 30 : 28,
          padding: "12px 0",
          fontFamily: "var(--font-body)", fontWeight: 500,
        }}>
          <LoopMark dotColor={dotColor} size={16} />
          {/* Label follows the dot color — same rule as the widget's .l-label,
              so the contrast warning below covers it too. */}
          <span style={{ fontSize: 11, writingMode: "vertical-rl", letterSpacing: "0.04em", color: dotColor }}>Feedback</span>
          {showDot && <span style={{ width: 6, height: 6, borderRadius: 999, background: dotColor }} />}
          {showFlag && (
            <span className="preview-flag" style={{
              position: "absolute",
              ...(edge === "right" ? { right: "calc(100% + 8px)" } : { left: "calc(100% + 8px)" }),
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex", alignItems: "center", gap: 5,
              whiteSpace: "nowrap",
            }}>
              Maya replied <span style={{ color: "var(--ember)", fontWeight: 600 }}>· 2</span>
            </span>
          )}
        </div>
        )}
        {visibility === "hidden" && (
          <span className="text-2xs" style={{
            position: "absolute", zIndex: 1,
            bottom: 10, left: "50%", transform: "translateX(-50%)",
            background: "var(--surface, #FBF7F0)",
            border: "var(--border)",
            borderRadius: 999,
            padding: "4px 10px",
            color: "var(--mute)",
            whiteSpace: "nowrap",
          }}>
            Launcher hidden. Your product opens it via window.crumb.open()
          </span>
        )}
      </div>

      {/* Flat whisper-tab treatment — the same recipe as the widget's .launcher
          CSS (apps/widget/src/styles.ts), driven by --lb so what the vendor
          picks here is what their customers see. Keep the two in sync.
          dangerouslySetInnerHTML (not a text child) so React doesn't
          HTML-escape the CSS in SSR. */}
      <style dangerouslySetInnerHTML={{ __html: `
        .preview-launcher {
          background: var(--lb);
          border: 1px solid rgba(255, 255, 255, 0.12);
          box-shadow: 0 1px 2px rgba(74, 46, 31, 0.08);
        }
        .preview-launcher[data-edge="right"] { border-right: 0; border-radius: 8px 0 0 8px; }
        .preview-launcher[data-edge="left"]  { border-left: 0;  border-radius: 0 8px 8px 0; }
        .preview-flag {
          background: #FBF7F0;
          color: #4A2E1F;
          border: 1px solid rgba(74, 46, 31, 0.16);
          border-radius: 6px;
          padding: 6px 10px;
          font-size: 12px;
          font-weight: 500;
          box-shadow: 0 1px 2px rgba(74, 46, 31, 0.08);
        }
      ` }} />
    </div>
  );
}

function ColorPicker({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="row gap-2 center">
      <label style={{
        width: 32, height: 32, borderRadius: "var(--r-sm)",
        background: value, border: "var(--border)",
        position: "relative", flexShrink: 0, cursor: "pointer",
      }}>
        <input
          type="color"
          aria-label={label}
          value={value}
          onChange={e => onChange(e.target.value)}
          style={{
            position: "absolute", inset: 0, opacity: 0, cursor: "pointer",
            width: "100%", height: "100%", border: 0, padding: 0,
          }}
        />
      </label>
      <input
        className="input mono"
        aria-label={`${label} (hex)`}
        value={value.toUpperCase()}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  );
}

export function BrandingCard({
  initialName,
  initialAccent,
  initialLauncherBg,
  initialEdge,
  initialVisibility,
  initialOffsetY,
  initialProductUrl,
}: {
  initialName: string;
  initialAccent: string;
  initialLauncherBg: string;
  initialEdge: Edge;
  initialVisibility: Visibility;
  initialOffsetY: number;
  initialProductUrl: string | null;
}) {
  const [name, setName] = useState(initialName);
  const [accent, setAccent] = useState(initialAccent);
  const [launcherBg, setLauncherBg] = useState(initialLauncherBg);
  const [edge, setEdge] = useState<Edge>(initialEdge);
  const [visibility, setVisibility] = useState<Visibility>(initialVisibility);
  const [offsetY, setOffsetY] = useState(initialOffsetY);
  const [productUrl, setProductUrl] = useState(initialProductUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [contrastWarning, setContrastWarning] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Auto-clear the "Saved · …" timestamp after a few seconds so it doesn't
  // linger past the next interaction.
  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(null), 5000);
    return () => clearTimeout(t);
  }, [savedAt]);

  const save = () => {
    setError(null);
    setContrastWarning(null);
    // Warn if the dot color and launcher color are too close — vendors can
    // walk into a "my dots are invisible" trap (we did during testing).
    // WCAG-ish: relative luminance ratio. Threshold 3.0 is intentionally
    // lenient — we warn, never block.
    const ratio = contrastRatio(accent, launcherBg);
    if (ratio < 3.0) {
      setContrastWarning(
        `Heads-up: your dot and launcher colors have a contrast ratio of ${ratio.toFixed(2)}. The loop mark and label may be hard to read. The preview on the right shows the live result.`,
      );
    }
    startTransition(async () => {
      const res = await saveBranding({
        name, accent, launcherBg, launcherEdge: edge,
        launcherVisibility: visibility, launcherOffsetY: offsetY,
        productUrl,
      });
      if (res.ok) setSavedAt(Date.now());
      else setError(res.error);
    });
  };

  return (
    <Card>
      <CardHead title="Branding" after={<Pill ring>Live preview →</Pill>} />
      <div
        className="card-body branding-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.1fr)",
          gap: 28,
          alignItems: "stretch",
        }}
      >
        <div className="col gap-4" style={{ minWidth: 0 }}>
          <Field label="Workspace name" help="Shown in the widget header and outbound emails.">
            <input className="input" value={name} onChange={e => setName(e.target.value)} />
          </Field>

          <Field label="Launcher color" help="The tab the loop mark sits inside. Defaults to a deep ink.">
            <ColorPicker label="Launcher color" value={launcherBg} onChange={setLauncherBg} />
          </Field>

          <Field label="Dot color" help="The five-dot loop mark and the loop-news dot, both in the widget and on the dashboard.">
            <ColorPicker label="Dot color" value={accent} onChange={setAccent} />
          </Field>

          <Field label="Edge" help="Which side of your product the whisper tab docks to.">
            <div className="seg" style={{ width: "100%" }}>
              {([
                { k: "right", label: "Right" },
                { k: "left", label: "Left" },
              ] as const).map(({ k, label }) => (
                <button
                  key={k}
                  aria-selected={edge === k}
                  aria-pressed={edge === k}
                  onClick={() => setEdge(k)}
                  style={{ flex: 1 }}
                >{label}</button>
              ))}
            </div>
          </Field>

          <Field
            label="Launcher visibility"
            help="Hide crumb's own tab if you already run another chat widget. Open the panel from your existing widget or button via window.crumb.open(). See Install for the snippet."
          >
            <div className="seg" style={{ width: "100%" }}>
              {([
                { k: "auto", label: "Shown" },
                { k: "hidden", label: "Hidden" },
              ] as const).map(({ k, label }) => (
                <button
                  key={k}
                  aria-selected={visibility === k}
                  aria-pressed={visibility === k}
                  onClick={() => setVisibility(k)}
                  style={{ flex: 1 }}
                >{label}</button>
              ))}
            </div>
          </Field>

          <Field
            label="Vertical nudge (px)"
            help="Moves the tab along the edge (positive = down from center) so it clears anything your product renders mid-edge. Also anchors the panel when the launcher is hidden."
          >
            <input
              className="input mono" type="number" aria-label="Vertical nudge"
              value={offsetY} onChange={e => setOffsetY(parseInt(e.target.value, 10) || 0)}
              style={{ width: 110 }}
            />
          </Field>

          <Field
            label="Product URL"
            help="The page where your widget runs. Customer emails link here and open their thread in the Feedback tab. Leave it blank and emails link to a read-only copy of the thread instead."
          >
            <input
              className="input"
              type="url"
              placeholder="https://app.yourproduct.com"
              value={productUrl}
              onChange={e => setProductUrl(e.target.value)}
            />
          </Field>

          {error && (
            <div className="text-sm" style={{
              background: "var(--err-bg)",
              border: "1px solid var(--err-border)",
              color: "var(--err-text)",
              borderRadius: "var(--r-sm)",
              padding: "8px 10px",
            }}>{error}</div>
          )}
          {contrastWarning && (
            <div className="text-xs" style={{
              background: "rgba(226, 125, 58, 0.10)",
              border: "1px solid rgba(226, 125, 58, 0.35)",
              color: "var(--ink)",
              borderRadius: "var(--r-sm)",
              padding: "8px 10px",
              lineHeight: 1.45,
            }}>{contrastWarning}</div>
          )}
          {savedAt && !error && (
            <span className="text-xs muted">Saved · {new Date(savedAt).toLocaleTimeString()}</span>
          )}

          <div className="row gap-2 mt-2">
            <Btn sm variant="primary" onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Btn>
            <Btn sm variant="ghost" onClick={() => {
              setName(initialName);
              setAccent(initialAccent);
              setLauncherBg(initialLauncherBg);
              setEdge(initialEdge);
              setVisibility(initialVisibility);
              setOffsetY(initialOffsetY);
              setProductUrl(initialProductUrl ?? "");
            }} disabled={pending}>Reset</Btn>
          </div>
        </div>

        <BrandingPreview dotColor={accent} launcherBg={launcherBg} edge={edge} offsetY={offsetY} visibility={visibility} initialSite={initialProductUrl ?? ""} />
      </div>
    </Card>
  );
}
