import { PageHead, SkeletonCard, SkeletonLine } from "@crumb/ui";

// Group-level fallback. Shown on cold loads into the (app) group when no
// route-specific loading.tsx exists yet, or while Next.js is still
// figuring out which segment we're on. Generic enough to map to any of
// the dashboard pages without feeling out of place.
export default function Loading() {
  return (
    <>
      <PageHead title={<SkeletonLine width="32%" height={26} />} lede={<SkeletonLine width="55%" height={12} />} />
      <SkeletonCard lines={4} />
      <SkeletonCard lines={3} />
    </>
  );
}
