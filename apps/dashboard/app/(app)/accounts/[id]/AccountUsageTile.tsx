import { Card, CardHead, Pill } from "@crumb/ui";
import { getActiveSession } from "@/lib/server";
import { usageAnalyticsAllowed } from "@/lib/entitlements";
import { accountUsageSignals, accountTopEvents } from "@/lib/usage/signals";

// Product-usage block on the account detail page — last active, weekly active
// users, and the features this account leans on. Sits beside ARR + feedback so
// a PM reads the quantitative ("they use Export daily") next to the qualitative
// (their feedback). Hidden when the workspace isn't entitled or has no events,
// mirroring AccountSessionsTile's off-by-default behavior.

function fmtAgo(d: Date): string {
  const ms = Date.now() - d.getTime();
  if (ms < 60_000) return "just now";
  const units: Array<[string, number]> = [
    ["w", 1000 * 60 * 60 * 24 * 7],
    ["d", 1000 * 60 * 60 * 24],
    ["h", 1000 * 60 * 60],
    ["m", 1000 * 60],
  ];
  for (const [u, mss] of units) if (ms >= mss) return `${Math.floor(ms / mss)}${u} ago`;
  return "just now";
}

export async function AccountUsageTile({ accountId }: { accountId: string }) {
  const { workspace } = await getActiveSession();
  if (!usageAnalyticsAllowed(workspace)) return null;

  const signals = await accountUsageSignals(workspace.id);
  const usage = signals.get(accountId);
  if (!usage || usage.eventCount30d === 0) return null;

  const topEvents = await accountTopEvents(accountId, 6);
  const maxCount = topEvents.reduce((m, e) => Math.max(m, e.count), 0) || 1;

  return (
    <Card>
      <CardHead title="Product usage" after={<Pill>{usage.lastActiveAt ? fmtAgo(usage.lastActiveAt) : "—"}</Pill>} />
      <div className="card-body col gap-3">
        <div className="row gap-4">
          <div className="col gap-1">
            <span className="eyebrow">Active users · 7d</span>
            <span className="text-lg">{usage.wau}</span>
          </div>
          <div className="col gap-1">
            <span className="eyebrow">Events · 30d</span>
            <span className="text-lg">{usage.eventCount30d.toLocaleString()}</span>
          </div>
        </div>

        {topEvents.length > 0 && (
          <div className="col gap-2">
            <span className="eyebrow">Top features · 30d</span>
            {topEvents.map((e) => (
              <div key={e.name} className="col gap-1">
                <div className="row gap-2 center">
                  <span className="text-sm mono truncate" style={{ flex: 1, minWidth: 0 }}>{e.name}</span>
                  <span className="text-xs muted">{e.count.toLocaleString()}</span>
                </div>
                <div style={{ height: 4, borderRadius: 999, background: "var(--surface-2)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.max(4, (e.count / maxCount) * 100)}%`, background: "var(--accent)", borderRadius: 999 }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
