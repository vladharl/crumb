import { Card, Ic, SkeletonCircle, SkeletonLine, SkeletonPill } from "@crumb/ui";
import css from "./inbox.module.css";

// Mirrors InboxTable's board so nothing moves when it lands: the toolbar
// (loop-turn tabs, search, sort) with the filters line under it, then the
// table on the real .inbox-grid tracks and column classes, so columns drop at
// the same widths and rows turn into cards on the phone like the live ones,
// and the "Showing" line below. Controls show disabled, at their real size.

// A Dropdown size="sm" showing `label`, as the filters and sort render it.
function Trigger({ label, minWidth }: { label: string; minWidth?: number }) {
  return (
    <span className="dd" style={{ position: "relative", display: "inline-block" }}>
      <button type="button" className="dd-trigger sm" disabled style={{ minWidth }}>
        <span className="dd-value">{label}</span>
        <Ic.chevD className="dd-chev" />
      </button>
    </span>
  );
}

export function InboxTableSkeleton() {
  return (
    <div className="inbox-board" aria-hidden>
      <div className="inbox-toolbar">
        <div className="inbox-toolbar-main">
          {/* No tab marked selected: e2e waits on the live tabs' aria-selected. */}
          <div className="seg">
            <button disabled>Your turn</button>
            <button disabled>Waiting</button>
            <button disabled>Closed</button>
            <button disabled>Mine</button>
            <button disabled>All</button>
          </div>
          <div className="inbox-search">
            <Ic.search style={{ width: 13, height: 13, color: "var(--mute)" }} />
            <input
              className="input search"
              aria-label="Search feedback, comments, and people"
              placeholder="Search everything: titles, comments, people…"
              disabled
              style={{ border: 0, padding: 0, background: "transparent" }}
            />
          </div>
          <div className="inbox-tools">
            <div className="inbox-sort">
              <span className="text-sm muted">Sort</span>
              <Trigger label="Longest waiting" minWidth={124} />
            </div>
          </div>
        </div>
        <div className={css.filters}>
          <Trigger label="Any status" />
          <Trigger label="Any type" />
          <Trigger label="Anyone" />
          <Trigger label="Any account" />
        </div>
      </div>

      <Card style={{ padding: 0 }}>
        <div className="inbox-scroll">
          <div className="list">
            <div className="list-row head inbox-grid">
              <span className="inbox-col-check" />
              <span className="inbox-col-id">ID</span>
              <span className="inbox-col-type">Type</span>
              <span>Title</span>
              <span className="inbox-col-account">Account · by</span>
              <span className="inbox-col-initiative">Initiative</span>
              <span>Status</span>
              <span className="inbox-col-asg">Asg.</span>
              <span>Activity</span>
              <span />
            </div>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="list-row inbox-grid inbox-row" style={{ opacity: 1 - i * 0.05 }}>
                <span className="inbox-col-check" />
                <span className="inbox-col-id"><SkeletonLine width={40} height={10} /></span>
                <span className="inbox-col-type"><SkeletonPill width={56} /></span>
                <span className="inbox-col-title col gap-1" style={{ minWidth: 0 }}>
                  <SkeletonLine width={i % 3 ? "78%" : "62%"} />
                  <SkeletonLine width="44%" height={10} />
                </span>
                <span className="inbox-col-account col gap-1" style={{ minWidth: 0 }}>
                  <SkeletonLine width="72%" />
                  <SkeletonLine width="48%" height={10} />
                </span>
                <span className="inbox-col-initiative"><SkeletonPill width={88} /></span>
                <span className="inbox-col-status"><SkeletonPill width={76} /></span>
                <span className="inbox-col-asg"><SkeletonCircle size={20} /></span>
                <span className="inbox-col-activity"><SkeletonLine width={40} height={10} /></span>
                <span className="inbox-col-actions" />
              </div>
            ))}
          </div>
        </div>
      </Card>

      <div className="row gap-3 center">
        <SkeletonLine width={110} height={12} />
      </div>
    </div>
  );
}
