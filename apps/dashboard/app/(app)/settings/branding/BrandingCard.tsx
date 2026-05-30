"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import { animate } from "motion";
import { Btn, Card, CardHead, Field, Pill, Switch } from "@crumb/ui";
import { saveBranding } from "./actions";

type Pos = "corner" | "pill" | "tab";

function readableOn(hex: string): string {
  const c = hex.replace("#", "");
  if (c.length !== 3 && c.length !== 6) return "var(--bone)";
  const full = c.length === 3 ? c.split("").map(x => x + x).join("") : c;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const L = 0.299 * r + 0.587 * g + 0.114 * b;
  return L > 150 ? "var(--ink)" : "var(--bone)";
}

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

// The same loop mark the widget mounts in its launcher. Sized for the
// 44px preview circle so the dots breathe inside the chip without
// crowding the edge.
function LoopMark({ dotColor, size = 24 }: { dotColor: string; size?: number }) {
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
  name, dotColor, launcherBg, pos, glass,
}: {
  name: string; dotColor: string; launcherBg: string; pos: Pos; glass: boolean;
}) {
  // Label text ("Feedback") sits on the launcher background, so its contrast
  // is against launcherBg — not the dot color.
  const fg = readableOn(launcherBg);
  const glassCls = glass ? " glass" : "";

  // Drive the preview loop mark with the same animation strategy as the
  // live widget so vendors see exactly what their customers will:
  //   - Motion rotates the <svg> root (single-element animation works)
  //   - Native WAAPI animates per-circle opacity (Motion's array form
  //     silently no-ops on SVGCircleElement collections)
  // The preview launcher is in a normal DOM (not shadow root) so the
  // failure mode is less severe than the widget side, but using the same
  // code path keeps the two visually identical.
  const previewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = previewRef.current;
    if (!root) return;
    const svg = root.querySelector("svg") as SVGSVGElement | null;
    const circles = Array.from(root.querySelectorAll("svg circle")) as SVGCircleElement[];
    if (!svg || circles.length === 0) return;
    svg.style.transformOrigin = "center";
    const spin = animate(
      svg,
      { rotate: [0, 360] },
      { duration: 1.6, repeat: Infinity, ease: "linear" },
    );
    const dotAnims = circles.map((c, i) =>
      c.animate(
        [{ opacity: 0.3 }, { opacity: 1 }, { opacity: 0.55 }],
        {
          duration: 1100,
          delay: i * 90,
          iterations: Infinity,
          easing: "cubic-bezier(0.32, 0.72, 0.36, 1)",
        },
      ),
    );
    return () => {
      spin.stop();
      for (const a of dotAnims) a.cancel();
    };
  }, [pos, dotColor, launcherBg]);

  return (
    <div
      ref={previewRef}
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
      </div>

      <div style={{ position: "relative", flex: 1, padding: 14, minHeight: 240 }}>
        <div style={{
          height: 22, display: "flex", alignItems: "center", gap: 10,
          paddingBottom: 8, borderBottom: "var(--border)", marginBottom: 12,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--ink)", opacity: 0.55 }} />
          <span className="text-2xs" style={{ color: "var(--mute)", letterSpacing: "0.05em" }}>northbeam.io / cohorts</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          <SkelTile />
          <SkelTile />
        </div>
        <SkelTile h={56} />
        <div style={{ height: 12 }} />
        <SkelTile h={42} />

        {pos === "pill" && (
          <div className={`preview-launcher preview-launcher--pill${glassCls}`} style={{
            ["--lb" as string]: launcherBg, color: fg,
            position: "absolute", right: 14, bottom: 14,
            height: 48, padding: "0 18px 0 15px", borderRadius: 999,
            display: "flex", alignItems: "center", gap: 9,
            fontFamily: "var(--font-body)", fontWeight: 500, whiteSpace: "nowrap",
          }}>
            <LoopMark dotColor={dotColor} size={20} />
            <span style={{ fontSize: 14 }}>Feedback</span>
          </div>
        )}

        {pos === "tab" && (
          <div className={`preview-launcher preview-launcher--tab${glassCls}`} style={{
            ["--lb" as string]: launcherBg, color: fg,
            position: "absolute", right: 0, top: "50%", transform: "translateY(-50%)",
            padding: "15px 8px", borderRadius: "12px 0 0 12px",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
            fontFamily: "var(--font-body)", fontWeight: 500,
          }}>
            <LoopMark dotColor={dotColor} size={20} />
            <span style={{ fontSize: 13, writingMode: "vertical-rl", letterSpacing: "0.02em" }}>Feedback</span>
          </div>
        )}

        {pos === "corner" && (
          <div style={{ position: "absolute", right: 14, bottom: 14, display: "flex", alignItems: "flex-end", gap: 10 }}>
            <span style={{
              background: "var(--ink)", color: "var(--bone-on-ink)",
              padding: "4px 8px", borderRadius: "var(--r-sm)",
              fontFamily: "var(--font-body)", fontSize: "var(--fs-2xs)",
              fontWeight: 500, letterSpacing: "0.04em",
              marginBottom: 6, whiteSpace: "nowrap",
            }}>
              Feedback for {name}
            </span>
            <span className={`preview-launcher preview-launcher--corner${glassCls}`} style={{
              ["--lb" as string]: launcherBg,
              width: 54, height: 54, borderRadius: "50%",
              display: "grid", placeItems: "center",
            }}>
              <LoopMark dotColor={dotColor} size={24} />
            </span>
          </div>
        )}
      </div>

      {/* Liquid-glass treatment — byte-for-byte the same recipe as the widget's
          .launcher CSS (apps/widget/src/styles.ts), driven by --lb so what the
          vendor picks here is what their customers see. Keep the two in sync.
          dangerouslySetInnerHTML (not a text child) so React doesn't HTML-escape
          the CSS — `content: ""` and `>` selectors would otherwise become
          &quot;/&gt; in SSR, breaking the rules AND the hydration match. */}
      <style dangerouslySetInnerHTML={{ __html: `
        .preview-launcher {
          position: relative;
          background: color-mix(in srgb, var(--lb) 82%, transparent);
          -webkit-backdrop-filter: blur(14px) saturate(0.95);
          backdrop-filter: blur(14px) saturate(0.95);
          border: 1px solid rgba(255, 255, 255, 0.10);
          box-shadow:
            0 1px 2px rgba(16, 18, 23, 0.12),
            0 6px 18px rgba(16, 18, 23, 0.16),
            inset 0 1px 0 rgba(255, 255, 255, 0.12);
        }
        .preview-launcher::before {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          pointer-events: none;
          z-index: 0;
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.10) 0%, rgba(255, 255, 255, 0) 40%);
        }
        .preview-launcher > svg, .preview-launcher > span { position: relative; z-index: 1; }
        .preview-launcher.glass {
          background: color-mix(in srgb, var(--lb) 62%, transparent);
          backdrop-filter: blur(18px) saturate(1.5);
          -webkit-backdrop-filter: blur(18px) saturate(1.5);
          border: 1px solid rgba(255, 255, 255, 0.22);
        }
      ` }} />
    </div>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="row gap-2 center">
      <label style={{
        width: 32, height: 32, borderRadius: "var(--r-sm)",
        background: value, border: "var(--border)",
        position: "relative", flexShrink: 0, cursor: "pointer",
      }}>
        <input
          type="color"
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
  initialPosition,
  initialGlass,
  initialProductUrl,
}: {
  initialName: string;
  initialAccent: string;
  initialLauncherBg: string;
  initialPosition: Pos;
  initialGlass: boolean;
  initialProductUrl: string | null;
}) {
  const [name, setName] = useState(initialName);
  const [accent, setAccent] = useState(initialAccent);
  const [launcherBg, setLauncherBg] = useState(initialLauncherBg);
  const [pos, setPos] = useState<Pos>(initialPosition);
  const [glass, setGlass] = useState(initialGlass);
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
        `Heads-up: your dot and launcher colors have a contrast ratio of ${ratio.toFixed(2)} — the dots may be hard to see. The preview on the right shows the live result.`,
      );
    }
    startTransition(async () => {
      const res = await saveBranding({ name, accent, launcherBg, launcherGlass: glass, position: pos, productUrl });
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

          <Field label="Launcher color" help="The launcher the dots sit inside. Defaults to a deep ink.">
            <ColorPicker value={launcherBg} onChange={setLauncherBg} />
          </Field>

          <Field label="Dot color" help="The five-dot loop mark, both in the widget and on the dashboard.">
            <ColorPicker value={accent} onChange={setAccent} />
          </Field>

          <Field label="Launcher style" help="How customers open the widget in your product.">
            <div className="seg" style={{ width: "100%" }}>
              {([
                { k: "corner", label: "FAB" },
                { k: "pill", label: "Pill" },
                { k: "tab", label: "Side-tab" },
              ] as const).map(({ k, label }) => (
                <button
                  key={k}
                  aria-selected={pos === k}
                  onClick={() => setPos(k)}
                  style={{ flex: 1 }}
                >{label}</button>
              ))}
            </div>
          </Field>

          <Field label="Glass effect" help="Frosted, translucent launcher that blends into busy or dark host pages.">
            <div className="row gap-2 center">
              <Switch on={glass} onClick={() => setGlass(g => !g)} />
              <span className="text-sm muted">{glass ? "On" : "Off"}</span>
            </div>
          </Field>

          <Field
            label="Product URL"
            help="Where the widget is embedded — used to build clickable links in customer notification emails. Leave blank to send link-less emails."
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
              setPos(initialPosition);
              setProductUrl(initialProductUrl ?? "");
            }} disabled={pending}>Reset</Btn>
          </div>
        </div>

        <BrandingPreview name={name} dotColor={accent} launcherBg={launcherBg} pos={pos} glass={glass} />
      </div>
    </Card>
  );
}
