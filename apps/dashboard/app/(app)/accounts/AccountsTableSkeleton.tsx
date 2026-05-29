import { Card, SkeletonRow } from "@crumb/ui";

const GRID = "1.4fr 80px 80px 80px 60px 60px 80px";

export function AccountsTableSkeleton() {
  return (
    <Card style={{ padding: 0 }}>
      <div className="list">
        <div className="list-row head" style={{ gridTemplateColumns: GRID }}>
          <span>Account</span>
          <span>ARR</span>
          <span>Users</span>
          <span>Open</span>
          <span>Shipped</span>
          <span>Total</span>
          <span>Since</span>
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonRow
            key={i}
            gridTemplateColumns={GRID}
            columns={["line", "line", "line", "pill", "line", "line", "line"]}
          />
        ))}
      </div>
    </Card>
  );
}
