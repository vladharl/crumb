import { Card, CardHead, SkeletonBlock, SkeletonCircle, SkeletonLine, SkeletonPill } from "@crumb/ui";

// page.tsx's one card: Invite in the head, then the member table on its grid.
const GRID = "1.4fr 1fr 130px 120px 1.2fr";

export default function Loading() {
  return (
    <Card>
      <CardHead title="Team & roles" after={<SkeletonBlock width={72} height={26} />} />
      <div className="list embed-stack" aria-hidden>
        <div className="list-row head" style={{ gridTemplateColumns: GRID }}>
          <span>Member</span><span>Email</span><span>Role</span><span>Status</span><span />
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="list-row" style={{ gridTemplateColumns: GRID, cursor: "default", background: "transparent" }}>
            <div className="row gap-3 center">
              <SkeletonCircle size={30} />
              <div className="col gap-1 grow">
                <SkeletonLine width="60%" />
                <SkeletonLine width="35%" height={10} />
              </div>
            </div>
            <SkeletonLine width="80%" />
            <SkeletonLine width={56} />
            <SkeletonPill width={64} />
            <span />
          </div>
        ))}
      </div>
    </Card>
  );
}
