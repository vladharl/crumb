import { Card, Ic, SkeletonLine, SkeletonRow } from "@crumb/ui";

// Mirrors the live InboxTable's desktop grid + chrome so nothing relabels or
// shifts on hydration: same column template, the "Activity" header, and the
// five loop-turn tabs the real toolbar shows.
const GRID = "28px 64px 86px minmax(180px, 1.4fr) 110px 140px 110px 56px 72px 22px";

export function InboxTableSkeleton() {
  return (
    <>
      <div className="row gap-3 center" style={{ flexWrap: "wrap" }}>
        <div
          className="row gap-2 center"
          style={{
            flex: 1, minWidth: 220,
            border: "var(--border)", borderRadius: "var(--r-sm)",
            padding: "6px 10px",
          }}
        >
          <Ic.search style={{ width: 13, height: 13, color: "var(--mute)" }} />
          <SkeletonLine width="60%" height={10} />
        </div>
        <div className="seg" aria-hidden>
          <button disabled>Your turn</button>
          <button disabled>Waiting</button>
          <button disabled>Closed</button>
          <button disabled>Mine</button>
          <button disabled>All</button>
        </div>
      </div>

      <Card style={{ padding: 0 }}>
        <div className="inbox-scroll">
          <div className="list">
            <div className="list-row head" style={{ gridTemplateColumns: GRID }}>
              <span />
              <span>ID</span>
              <span>Type</span>
              <span>Title</span>
              <span>Account · by</span>
              <span>Initiative</span>
              <span>Status</span>
              <span>Asg.</span>
              <span>Activity</span>
              <span />
            </div>
            {Array.from({ length: 12 }).map((_, i) => (
              <SkeletonRow
                key={i}
                gridTemplateColumns={GRID}
                columns={["blank", "line", "pill", "line", "line", "line", "pill", "circle", "line", "blank"]}
                style={{ opacity: 1 - i * 0.05 }}
              />
            ))}
          </div>
        </div>
      </Card>
    </>
  );
}
