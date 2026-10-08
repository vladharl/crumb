import { Card, CardHead, SkeletonBlock, SkeletonCard, SkeletonLine, SkeletonPill } from "@crumb/ui";

// page.tsx's two cards: Branding (the fields beside the live preview), then
// Public pages.
export default function Loading() {
  return (
    <>
      <Card>
        <CardHead title="Branding" after={<SkeletonPill width={96} />} />
        <div
          className="card-body branding-grid"
          style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.1fr)", gap: 28 }}
          aria-hidden
        >
          <div className="col gap-4">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="col gap-2">
                <SkeletonLine width={90} height={10} />
                <SkeletonBlock height={36} />
                <SkeletonLine width="70%" height={10} />
              </div>
            ))}
          </div>
          <SkeletonBlock height="100%" style={{ minHeight: 340 }} />
        </div>
      </Card>
      <SkeletonCard title="Public pages" lines={3} />
    </>
  );
}
