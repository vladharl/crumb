import Link from "next/link";
import {
  Card, CardHead, Ic, PageHead, SkeletonBlock, SkeletonCircle, SkeletonLine, SkeletonPill, StatusDot,
  VENDOR_STATUS_OPTIONS,
} from "@crumb/ui";

// Mirrors ThreadView in order and size so nothing jumps when the thread lands:
// the header (trail, status pill), the status bar it shows under 1024px, the
// Customer / Internal / Trail tabs, then the conversation with its reply
// composer beside the Details and Status cards. Fixed chrome (tab names, card
// titles, the status list) renders as itself; only the data shimmers.
export function ThreadSkeleton({ shortId }: { shortId?: string }) {
  return (
    <>
      <PageHead
        crumb={<><Link href="/inbox" style={{ color: "inherit" }}>Inbox</Link><Ic.chevR style={{ width: 10, height: 10 }} />{shortId ? <span className="mono">{shortId}</span> : <SkeletonLine width={48} height={10} />}</>}
        title={<SkeletonLine width="55%" height={22} />}
        // Carry the morph names on the skeleton too, so an opening row has a
        // target on the very first frame (before content streams) — the title
        // lifts into this heading slot and the loop dot into the trail slot,
        // then the real header takes their place in situ. Keeps the morph
        // robust regardless of how long the thread data takes to load.
        titleStyle={{ viewTransitionName: "vt-thread-title" }}
        actions={
          <>
            <span style={{ viewTransitionName: "vt-thread-trail", display: "inline-flex", lineHeight: 0 }}><SkeletonPill width={42} /></span>
            <SkeletonPill width={84} />
          </>
        }
      />

      {/* ThreadView's .thread-bar (status + assignee), shown under 1024px. */}
      <div className="thread-bar" aria-hidden>
        <SkeletonLine width={40} height={10} />
        <SkeletonBlock width={130} height={28} />
        <SkeletonBlock width={120} height={28} />
      </div>

      <div className="seg" style={{ alignSelf: "flex-start" }} aria-hidden>
        <button disabled>Customer</button>
        <button disabled>Internal</button>
        <button disabled>Trail</button>
      </div>

      <div className="cols-2-1" style={{ alignItems: "start" }} aria-hidden>
        <Card>
          <div className="card-body col gap-5">
            {[0, 1, 2].map(i => (
              <div key={i} className="row gap-3" style={{ alignItems: "flex-start" }}>
                <SkeletonCircle size={30} />
                <div className="col gap-2 grow">
                  <SkeletonLine width={i === 1 ? "28%" : "36%"} height={14} />
                  <SkeletonLine width="100%" />
                  <SkeletonLine width={i === 1 ? "64%" : "88%"} />
                </div>
              </div>
            ))}
          </div>
          {/* The reply composer: Reply / Internal note, the box, its buttons. */}
          <div className="card-foot col gap-3" style={{ alignItems: "stretch" }}>
            <div className="row gap-3 center">
              <div className="seg">
                <button disabled>Reply</button>
                <button disabled>Internal note</button>
              </div>
              <SkeletonLine width="40%" height={10} />
            </div>
            <SkeletonBlock height={78} />
            <div className="row gap-2 center">
              <SkeletonBlock width={30} height={30} />
              <div style={{ flex: 1 }} />
              <SkeletonBlock width={110} height={30} />
            </div>
          </div>
        </Card>

        <div className="col gap-4" style={{ minWidth: 0 }}>
          <Card>
            <CardHead title="Details" />
            <div className="card-body col gap-3">
              <div className="row gap-3 center">
                <SkeletonCircle size={30} />
                <div className="col gap-1 grow">
                  <SkeletonLine width="60%" />
                  <SkeletonLine width="32%" height={10} />
                </div>
              </div>
              <span className="eyebrow">Submitter</span>
              <div className="row gap-2 center">
                <SkeletonCircle size={22} />
                <SkeletonLine width="45%" />
              </div>
              <span className="eyebrow">Assignee</span>
              <SkeletonBlock height={28} />
              <span className="eyebrow">Type</span>
              <SkeletonBlock height={28} />
            </div>
          </Card>

          <Card>
            <CardHead title="Status" />
            <div className="card-body col gap-1">
              {VENDOR_STATUS_OPTIONS.map(({ value, label }) => (
                <div key={value} className="nav-item" style={{ gap: 12, cursor: "default" }}>
                  <StatusDot status={value} />
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
