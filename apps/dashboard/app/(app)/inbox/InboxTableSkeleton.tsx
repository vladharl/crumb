import { Card, Ic, SkeletonLine, SkeletonRow } from "@crumb/ui";

const GRID = "28px 64px 86px 1.4fr 110px 140px 110px 56px 56px 22px";

// Mirrors the structure of InboxTable while data is loading: the toolbar
// (search + tabs) renders as static chrome (no data needed), and the table
// body shows 12 skeleton rows that match the live grid template.
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
          <Ic.search style={{ width: 13, height: 13, color: "var(--mute-2)" }} />
          <SkeletonLine width="60%" height={10} />
        </div>
        <div className="seg" aria-hidden>
          <button disabled>All</button>
          <button disabled>Open</button>
          <button disabled>Mine</button>
        </div>
      </div>

      <Card style={{ padding: 0 }}>
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
            <span>Age</span>
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
      </Card>
    </>
  );
}
