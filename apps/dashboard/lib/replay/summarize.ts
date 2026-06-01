import "server-only";
import { getManifest, getChunk } from "@/lib/replay/read";

// Reduce raw rrweb events to a compact, human-readable action trace for the AI
// summarizer (feature 8). Pure (no aistack) — bundle-safe. The chunk endpoint
// stores raw rrweb-events JSON, so we JSON.parse each chunk.
//
// We don't reimplement rrweb's replayer; we extract the load-bearing beats:
// navigations, labeled clicks (labels read from the initial full snapshot),
// typing, rapid-repeat clicks, and idle gaps. That's enough for a model to
// narrate "hunted for Export for 40s, then went idle".

type RRNode = {
  type: number; // 0 Document, 1 DocumentType, 2 Element, 3 Text, …
  id?: number;
  tagName?: string;
  attributes?: Record<string, string>;
  childNodes?: RRNode[];
  textContent?: string;
};
type RREvent = { type: number; timestamp?: number; data?: any };

function collectText(node: RRNode, depth = 0): string {
  if (depth > 6) return "";
  if (node.type === 3) return node.textContent ?? "";
  if (node.childNodes) return node.childNodes.map(c => collectText(c, depth + 1)).join("");
  return "";
}

// Map element id → label for clickable elements in the initial DOM snapshot.
function buildLabelMap(root: RRNode, map: Map<number, string>): void {
  const walk = (n: RRNode) => {
    if (n.type === 2 && n.id != null) {
      const tag = (n.tagName ?? "").toLowerCase();
      const role = n.attributes?.role;
      const inputType = (n.attributes?.type ?? "").toLowerCase();
      const clickable =
        tag === "a" || tag === "button" || role === "button" ||
        (tag === "input" && (inputType === "submit" || inputType === "button"));
      if (clickable) {
        let label = collectText(n).replace(/\s+/g, " ").trim();
        if (!label && n.attributes) {
          label = (n.attributes["aria-label"] || n.attributes["title"] || n.attributes.value || "").trim();
        }
        if (label) map.set(n.id, label.slice(0, 40));
      }
    }
    n.childNodes?.forEach(walk);
  };
  walk(root);
}

export type ActionTrace = { trace: string; lineCount: number };

export async function extractActionTrace(
  sessionId: string,
  workspaceId: string,
): Promise<ActionTrace | null> {
  const manifest = await getManifest(sessionId, workspaceId);
  if (!manifest) return null;

  const events: RREvent[] = [];
  for (const c of manifest.chunks) {
    const buf = await getChunk(sessionId, c.sequence, workspaceId);
    if (!buf) continue;
    try {
      const parsed = JSON.parse(buf.toString("utf8"));
      if (Array.isArray(parsed)) events.push(...parsed);
    } catch {
      // Skip an unparseable chunk rather than failing the whole trace.
    }
  }
  if (events.length === 0) return null;

  events.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const t0 = events[0].timestamp ?? 0;

  const labels = new Map<number, string>();
  for (const e of events) {
    if (e.type === 2 && e.data?.node) { buildLabelMap(e.data.node as RRNode, labels); break; }
  }

  const fmt = (ts: number) => {
    const s = Math.max(0, Math.round((ts - t0) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };

  const out: string[] = [];
  let lastTs = t0;
  let recentClicks: number[] = [];
  let lastWasTyping = false;

  for (const e of events) {
    const ts = e.timestamp ?? lastTs;
    const gap = ts - lastTs;
    if (gap > 5000) out.push(`${fmt(ts)} idle ${Math.round(gap / 1000)}s`);
    lastTs = ts;

    // Meta (navigation)
    if (e.type === 4 && e.data?.href) {
      const path = String(e.data.href).replace(/^https?:\/\/[^/]+/, "") || "/";
      out.push(`${fmt(ts)} navigated to ${path}`);
      lastWasTyping = false;
      continue;
    }
    // Full snapshot (page (re)load)
    if (e.type === 2) {
      out.push(`${fmt(ts)} page loaded`);
      lastWasTyping = false;
      continue;
    }
    // Incremental snapshot
    if (e.type === 3 && e.data) {
      const src = e.data.source;
      // MouseInteraction: 2 = Click, 4 = DblClick
      if (src === 2 && (e.data.type === 2 || e.data.type === 4)) {
        const label = e.data.id != null ? labels.get(e.data.id) : undefined;
        out.push(`${fmt(ts)} clicked${label ? ` "${label}"` : ""}`);
        recentClicks.push(ts);
        recentClicks = recentClicks.filter(x => ts - x <= 1500);
        if (recentClicks.length >= 3) { out.push(`${fmt(ts)} (rapid repeated clicks — possible frustration)`); recentClicks = []; }
        lastWasTyping = false;
      } else if (src === 5) {
        if (!lastWasTyping) { out.push(`${fmt(ts)} typed in a field`); lastWasTyping = true; }
      }
    }
  }

  // Cap for the prompt — keep the head (where the intent usually is) + tail.
  const lines = out.length <= 120 ? out : [...out.slice(0, 90), `… (${out.length - 110} more) …`, ...out.slice(-20)];
  return { trace: lines.join("\n"), lineCount: out.length };
}
