import { SkeletonCard } from "@crumb/ui";

export default function Loading() {
  return (
    <>
      <SkeletonCard title="Engineering sync" lines={4} />
      <SkeletonCard title="Vendor-side Slack" lines={3} />
    </>
  );
}
