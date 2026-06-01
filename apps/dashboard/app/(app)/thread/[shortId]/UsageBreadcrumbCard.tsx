import { Card, CardHead, Pill } from "@crumb/ui";

// A lightweight breadcrumb of what the submitter was doing leading up to this
// feedback — the named usage events captured by crumb.track(). Complements the
// session replay: replay is the full recording (when consent + recording were
// on), this is the always-available trail. Rendered only when there are events.

export type UsageBreadcrumbEntry = { name: string; at: string; pageUrl: string | null };

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function shortPath(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.pathname && u.pathname !== "/" ? u.pathname : null;
  } catch {
    return null;
  }
}

export function UsageBreadcrumbCard({ entries }: { entries: UsageBreadcrumbEntry[] }) {
  if (!entries.length) return null;
  return (
    <Card>
      <CardHead title="Before this feedback" after={<Pill>{entries.length}</Pill>} />
      <div className="card-body col gap-2">
        {entries.map((e, i) => {
          const path = shortPath(e.pageUrl);
          return (
            <div key={`${e.name}-${e.at}-${i}`} className="row gap-2 center">
              <span style={{ width: 5, height: 5, borderRadius: 999, background: "var(--accent)", flexShrink: 0, opacity: 0.7 }} />
              <span className="text-sm mono truncate" style={{ flex: 1, minWidth: 0 }}>{e.name}</span>
              {path && <span className="text-2xs muted truncate" style={{ maxWidth: 120 }} title={e.pageUrl ?? undefined}>{path}</span>}
              <span className="text-2xs muted" style={{ flexShrink: 0 }}>{fmtTime(e.at)}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
