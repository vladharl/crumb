import { Card, CardHead, SkeletonCard, SkeletonCircle, SkeletonLine } from "@crumb/ui";

export function NotificationsFeedSkeleton() {
  return (
    <Card>
      <CardHead title={<SkeletonLine width={120} height={12} />} />
      <div className="list">
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className="list-row"
            style={{ gridTemplateColumns: "1fr 60px 12px", padding: "14px 18px" }}
          >
            <div className="col gap-1 grow">
              <SkeletonLine width={i % 2 ? "78%" : "65%"} />
              <SkeletonLine width={56} height={10} />
            </div>
            <SkeletonLine width={32} height={10} />
            <SkeletonCircle size={6} />
          </div>
        ))}
      </div>
    </Card>
  );
}

export function NotificationsSidebarSkeleton() {
  return (
    <div className="col gap-4">
      <SkeletonCard title="Preferences" lines={6} />
      <SkeletonCard title="Digest preview · tomorrow 9am" lines={4} />
    </div>
  );
}
