import { Card, SkeletonCircle, SkeletonKpiStrip, SkeletonLine, SkeletonPill } from "@crumb/ui";

// Mirrors AccountsTableTile: the KPI card, then rows on the same
// .accounts-row tracks and acct-* cells, so the phone reflow matches too.
export function AccountsTableSkeleton() {
  return (
    <>
      <Card>
        <div className="card-body">
          <SkeletonKpiStrip count={4} />
        </div>
      </Card>

      <Card style={{ padding: 0 }}>
        <div className="list">
          <div className="list-row head accounts-row">
            <span>Account</span>
            <span>ARR</span>
            <span>Open</span>
            <span>Shipped</span>
            <span>Total</span>
            <span>Since</span>
          </div>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="list-row accounts-row" style={{ alignItems: "center" }}>
              <div className="acct-name row gap-3 center" style={{ minWidth: 0 }}>
                <SkeletonCircle size={24} />
                <div className="col gap-1 grow" style={{ minWidth: 0 }}>
                  <SkeletonLine width="60%" />
                  <SkeletonLine width="40%" height={10} />
                </div>
              </div>
              <div className="acct-arr row gap-2 center" style={{ minWidth: 0 }}>
                <SkeletonLine height={6} style={{ flex: 1, minWidth: 40 }} />
                <SkeletonLine width={48} />
              </div>
              <span className="acct-open"><SkeletonPill width={28} /></span>
              <span className="acct-shipped"><SkeletonLine width={24} /></span>
              <span className="acct-total"><SkeletonLine width={24} /></span>
              <span className="acct-since"><SkeletonLine width={48} /></span>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
