import { Card, SkeletonRow } from "@crumb/ui";

const GRID = "60px 1.6fr 100px 70px 70px 140px";

export function InitiativesTableSkeleton() {
  return (
    <Card style={{ padding: 0 }}>
      <div className="list">
        <div className="list-row head" style={{ gridTemplateColumns: GRID }}>
          <span>ID</span>
          <span>Initiative</span>
          <span>Status</span>
          <span>Open</span>
          <span>Total</span>
          <span>Owner</span>
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonRow
            key={i}
            gridTemplateColumns={GRID}
            columns={["line", "line", "pill", "line", "line", "line"]}
          />
        ))}
      </div>
    </Card>
  );
}
