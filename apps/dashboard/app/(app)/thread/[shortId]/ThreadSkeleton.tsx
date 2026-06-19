import { Card, CardHead, Ic, PageHead, SkeletonCard, SkeletonCircle, SkeletonLine, SkeletonPill } from "@crumb/ui";

// Mirrors ThreadView's PageHead + tabs + cols-2-1 layout while data is
// loading. Left column shows a card-frame with 4 alternating "bubbles"
// (customer / vendor), right column shows the four side cards (Status /
// Initiative / Engineering / Account) as stacked SkeletonCards.
export function ThreadSkeleton({ shortId }: { shortId?: string }) {
  return (
    <>
      <PageHead
        crumb={<><span>Inbox</span><Ic.chevR style={{ width: 10, height: 10 }} />{shortId ? <span className="mono">{shortId}</span> : <SkeletonLine width={48} height={10} />}</>}
        title={<SkeletonLine width="55%" height={22} />}
        // Carry the morph names on the skeleton too, so an opening row has a
        // target on the very first frame (before content streams) — the title
        // lifts into this heading slot and the loop dot into the trail slot,
        // then the real header takes their place in situ. Keeps the morph
        // robust regardless of how long the thread data takes to load.
        titleStyle={{ viewTransitionName: "vt-thread-title" }}
        actions={<span style={{ viewTransitionName: "vt-thread-trail", display: "inline-flex", lineHeight: 0 }}><SkeletonPill width={84} /></span>}
      />

      <div className="seg" aria-hidden>
        <button disabled>Customer</button>
        <button disabled>Internal</button>
        <button disabled>Trail</button>
      </div>

      <div className="cols-2-1" style={{ alignItems: "start" }}>
      <Card>
        <div className="card-body col gap-5">
          {[true, false, true, false].map((isCustomer, i) => (
            <div key={i} className="row gap-3" style={{ alignItems: "flex-start", flexDirection: isCustomer ? "row" : "row-reverse" }}>
              <SkeletonCircle size={28} />
              <div className="col gap-2" style={{ flex: 1, maxWidth: "62%" }}>
                <SkeletonLine width={isCustomer ? "32%" : "28%"} height={10} />
                <SkeletonLine width="100%" />
                <SkeletonLine width={isCustomer ? "92%" : "84%"} />
                {i % 2 === 0 && <SkeletonLine width="40%" />}
              </div>
            </div>
          ))}
          <div className="row gap-2 center" style={{ borderTop: "var(--border)", paddingTop: 12 }}>
            <SkeletonCircle size={20} />
            <SkeletonLine width="40%" height={10} />
          </div>
        </div>
      </Card>

      <div className="col gap-4">
        <Card>
          <CardHead title={<SkeletonLine width={60} height={12} />} />
          <div className="card-body col gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="row gap-3 center">
                <SkeletonCircle size={10} />
                <SkeletonLine width={i % 2 ? "55%" : "72%"} />
              </div>
            ))}
          </div>
        </Card>

        <SkeletonCard title={<SkeletonLine width={70} height={12} />} lines={2} />
        <SkeletonCard title={<SkeletonLine width={90} height={12} />} lines={3} />
      </div>
    </div>
    </>
  );
}
