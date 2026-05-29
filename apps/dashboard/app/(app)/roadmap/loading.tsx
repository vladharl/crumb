import { PageHead, SkeletonCard } from "@crumb/ui";

export default function Loading() {
  return (
    <>
      <PageHead crumb="Daily" title="Roadmap" lede="A view of what's planned, in progress, and shipped." />
      <SkeletonCard lines={4} />
    </>
  );
}
