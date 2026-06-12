"use server";

import { eq } from "drizzle-orm";
import { db, workspaces } from "@crumb/db";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth";

type SaveInput = {
  name?: string;
  accent?: string;
  launcherBg?: string;
  launcherEdge?: string;
  launcherVisibility?: string;
  launcherOffsetY?: number;
  productUrl?: string;
};

const VALID_EDGES = new Set(["right", "left"]);
const VALID_VISIBILITY = new Set(["auto", "always", "hidden"]);
// Keep the nudge sane — enough to clear something the host renders mid-edge,
// not enough to fling the tab off-screen.
const MAX_OFFSET = 400;

export type SaveResult = { ok: true } | { ok: false; error: string };

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export async function saveBranding(input: SaveInput): Promise<SaveResult> {
  const { workspace, user } = await requireSession();
  if (user.role !== "admin") return { ok: false, error: "Only admins can edit branding." };

  const patch: Record<string, string | boolean | number | null> = {};

  if (typeof input.name === "string") {
    const name = input.name.trim();
    if (!name) return { ok: false, error: "Workspace name can't be empty." };
    patch.name = name;
  }

  if (typeof input.accent === "string") {
    if (!HEX_RE.test(input.accent)) return { ok: false, error: "Dot color must be a six-digit hex (e.g. #E27D3A)." };
    patch.accent = input.accent.toUpperCase();
  }

  if (typeof input.launcherBg === "string") {
    if (!HEX_RE.test(input.launcherBg)) return { ok: false, error: "Launcher color must be a six-digit hex (e.g. #4A2E1F)." };
    patch.launcherBg = input.launcherBg.toUpperCase();
  }

  if (typeof input.launcherEdge === "string") {
    if (!VALID_EDGES.has(input.launcherEdge)) return { ok: false, error: "Pick a valid launcher edge." };
    patch.launcherEdge = input.launcherEdge;
  }

  if (typeof input.launcherVisibility === "string") {
    if (!VALID_VISIBILITY.has(input.launcherVisibility)) return { ok: false, error: "Pick a valid launcher visibility." };
    patch.launcherVisibility = input.launcherVisibility;
  }

  if (typeof input.launcherOffsetY === "number") {
    const v = input.launcherOffsetY;
    if (!Number.isFinite(v) || Math.abs(v) > MAX_OFFSET) return { ok: false, error: `Nudge must be between -${MAX_OFFSET} and ${MAX_OFFSET}px.` };
    patch.launcherOffsetY = Math.round(v);
  }

  if (typeof input.productUrl === "string") {
    const url = input.productUrl.trim();
    if (url === "") {
      patch.productUrl = null;
    } else {
      try {
        const parsed = new URL(url);
        if (!/^https?:$/.test(parsed.protocol)) return { ok: false, error: "Product URL must start with http:// or https://." };
        patch.productUrl = parsed.toString();
      } catch {
        return { ok: false, error: "Product URL doesn't look like a valid URL." };
      }
    }
  }

  if (Object.keys(patch).length === 0) return { ok: true };

  await db.update(workspaces).set(patch).where(eq(workspaces.id, workspace.id));
  revalidatePath("/settings/branding");
  return { ok: true };
}

// ─── live site preview ───────────────────────────────────────
// Fetches the vendor's real site server-side (their browser couldn't — most
// sites send X-Frame-Options / frame-ancestors) and returns sanitized HTML
// for a sandboxed srcdoc iframe. Scripts are KEPT (JS-rendered apps would
// otherwise show their <noscript> shell) — the iframe runs them with
// `sandbox="allow-scripts"` only: opaque origin, no parent access, inert.
// Meta CSP/refresh are stripped, and every asset URL is rewritten to
// absolute. We can't use a <base> for that: srcdoc documents inherit the
// dashboard's own CSP, whose `base-uri 'self'` (next.config.mjs) blocks
// foreign base elements.

export type SitePreviewResult =
  | { ok: true; html: string; thin: boolean }
  | { ok: false; error: string };

const PREVIEW_TIMEOUT_MS = 8_000;
const PREVIEW_MAX_BYTES = 2_000_000;

// SSRF guard: this action fetches an arbitrary URL with server credentials of
// nothing — but it can still reach the box's own network. Block the obvious
// internal targets; literal-IP + localhost coverage is enough for a
// single-tenant box (no cloud metadata service to protect).
function isBlockedHost(host: string): boolean {
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) return true;
  if (host === "::1" || host.startsWith("[")) return true; // IPv6 literals
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}

export async function fetchSitePreview(rawUrl: string): Promise<SitePreviewResult> {
  const { user } = await requireSession();
  if (user.role !== "admin") return { ok: false, error: "Only admins can preview a site." };

  const input = rawUrl.trim();
  if (!input) return { ok: false, error: "Enter a URL." };
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return { ok: false, error: "That doesn't look like a URL." };
  }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, error: "Only http(s) URLs can be previewed." };
  if (isBlockedHost(url.hostname)) return { ok: false, error: "That host can't be previewed." };

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
      redirect: "follow",
      headers: {
        // A browsery UA — some sites serve bot-blocker pages to bare fetch UAs.
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
  } catch {
    return { ok: false, error: "Couldn't reach that site." };
  }
  if (!res.ok) return { ok: false, error: `The site answered ${res.status}.` };
  if (!(res.headers.get("content-type") ?? "").includes("text/html")) {
    return { ok: false, error: "That URL isn't an HTML page." };
  }

  let html = (await res.text()).slice(0, PREVIEW_MAX_BYTES);
  html = html
    .replace(/<base[^>]*>/gi, "")
    .replace(/<meta[^>]+http-equiv=["']?(content-security-policy|refresh)["']?[^>]*>/gi, "");

  // Absolutize against the post-redirect URL. Quoted attributes only — that's
  // what real-world markup uses; an unquoted straggler just 404s its asset.
  const finalUrl = res.url;
  const abs = (v: string): string => {
    const t = v.trim();
    if (!t || /^(data:|blob:|mailto:|tel:|javascript:|#)/i.test(t)) return v;
    try { return new URL(t, finalUrl).toString(); } catch { return v; }
  };
  html = html
    .replace(/(\s(?:src|href|poster|action)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (_m, pre, dq, sq) => {
      const quote = dq !== undefined ? '"' : "'";
      return `${pre}${quote}${abs(dq ?? sq ?? "")}${quote}`;
    })
    .replace(/(\s(?:srcset|imagesrcset)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (_m, pre, dq, sq) => {
      const quote = dq !== undefined ? '"' : "'";
      const rewritten = (dq ?? sq ?? "").split(",").map((part: string) => {
        const seg = part.trim();
        if (!seg) return seg;
        const [u, ...rest] = seg.split(/\s+/);
        return [abs(u ?? ""), ...rest].join(" ");
      }).join(", ");
      return `${pre}${quote}${rewritten}${quote}`;
    })
    .replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (_m, q, u) => `url(${q}${abs(u)}${q})`);

  // SPA shells ship almost no markup — the page may mount via JS or stay
  // blank (auth-walled apps). Flag it so the UI can say so instead of
  // leaving the vendor staring at a white pane.
  const visibleText = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const thin = visibleText.length < 200;

  return { ok: true, html, thin };
}
