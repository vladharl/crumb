import Link from "next/link";
import {
  Card, CardHead, PageHead,
  SkeletonCard, SkeletonCircle, SkeletonKpiStrip, SkeletonLine, SkeletonPill, SkeletonRow,
} from "@crumb/ui";

const FEEDBACK_GRID = "64px 86px 1fr 120px 110px 90px 56px";

export function AccountHeroSkeleton() {
  return (
    <>
      <PageHead
        crumb={<Link href="/accounts" style={{ color: "inherit" }}>Accounts</Link>}
        title={<SkeletonLine width="34%" height={26} />}
        lede="Everything they've submitted, replied to, and seen ship. The view to open before every QBR."
      />
      <Card>
        <div className="card-body row gap-5" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <SkeletonCircle size={56} />
          <div className="col gap-2 grow" style={{ minWidth: 220 }}>
            <div className="row gap-3 center" style={{ flexWrap: "wrap" }}>
              <SkeletonLine width={200} height={28} />
              <SkeletonPill width={84} />
              <SkeletonPill width={92} />
            </div>
            <SkeletonLine width="55%" height={12} />
          </div>
          <SkeletonKpiStrip count={4} />
        </div>
      </Card>
    </>
  );
}

export function AccountFeedbackSkeleton() {
  return (
    <Card>
      <CardHead title={<SkeletonLine width={140} height={12} />} />
      <div className="list">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonRow
            key={i}
            gridTemplateColumns={FEEDBACK_GRID}
            columns={["line", "pill", "line", "line", "pill", "line", "line"]}
          />
        ))}
      </div>
    </Card>
  );
}

export function AccountSidebarSkeleton() {
  return (
    <div className="col gap-4">
      <SkeletonCard title="Top requesters" lines={4} />
      <SkeletonCard title="Status mix" lines={5} />
    </div>
  );
}

export function AccountSessionsSkeleton() {
  return <SkeletonCard title="Session replays" lines={3} />;
}
