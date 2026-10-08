import { SkeletonCard, SkeletonPill } from "@crumb/ui";

export default function Loading() {
  return <SkeletonCard title="Audit log" after={<SkeletonPill width={96} />} lines={6} />;
}
