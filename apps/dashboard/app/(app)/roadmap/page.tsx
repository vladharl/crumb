import { Card, Ic, PageHead, Pill } from "@crumb/ui";

export const dynamic = "force-dynamic";

export default function RoadmapPage() {
  return (
    <>
      <PageHead
        crumb="Roadmap"
        title="Roadmap"
        lede="Now / Next / Later, public to your customers. Coming soon."
        actions={<Pill ring>Coming soon</Pill>}
      />

      <Card>
        <div className="card-body col gap-4" style={{ alignItems: "flex-start", padding: 32, minHeight: 220 }}>
          <Ic.road style={{ width: 22, height: 22, color: "var(--mute)" }} />
          <div className="col gap-1">
            <span className="serif" style={{ fontSize: 22, lineHeight: 1.25 }}>What you'll see here</span>
            <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
              A three-column board: <strong style={{ color: "var(--ink)", fontWeight: 500 }}>Now / Next / Later</strong>. Items move in as you mark them <em>Planned</em>. Customers see a filtered version inside the widget — only what you've marked public, and only what's relevant to their account.
            </p>
          </div>
          <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: "62ch" }}>
            Dialogue over voting: there's no upvote count. Customers <em>follow</em> items to subscribe to updates. Per-vendor controls let you mark items private (default) or public (opt-in).
          </p>
        </div>
      </Card>
    </>
  );
}
