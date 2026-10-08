import Link from "next/link";
import {
  Card, CardHead, PageHead,
  SkeletonCircle, SkeletonKpiStrip, SkeletonLine, SkeletonPill, SkeletonRow,
} from "@crumb/ui";

const GRID = "64px 86px 1fr 140px 110px 90px 56px";

export function InitiativeHeaderSkeleton() {
  return (
    <>
      <PageHead
        crumb={<Link href="/initiatives" style={{ color: "inherit" }}>Initiatives</Link>}
        title={<SkeletonLine width="40%" height={26} />}
        lede="Group inbound feedback that belongs together so you can triage themes, not just rows."
        actions={<SkeletonPill width={68} />}
      />
      <Card>
        <div className="card-body row gap-5" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <SkeletonCircle size={44} />
          <div className="col gap-2 grow" style={{ minWidth: 220 }}>
            <div className="row gap-3 center" style={{ flexWrap: "wrap" }}>
              <SkeletonLine width={48} height={10} />
              <SkeletonPill />
              <SkeletonPill width={100} />
            </div>
            <SkeletonLine width="35%" height={12} />
          </div>
          <SkeletonKpiStrip count={4} />
        </div>
      </Card>
    </>
  );
}

export function InitiativeFeedbackSkeleton() {
  return (
    <Card style={{ padding: 0 }}>
      <CardHead title={<SkeletonLine width={110} height={12} />} />
      <div className="list">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonRow
            key={i}
            gridTemplateColumns={GRID}
            columns={["line", "pill", "line", "line", "pill", "line", "line"]}
          />
        ))}
      </div>
    </Card>
  );
}
