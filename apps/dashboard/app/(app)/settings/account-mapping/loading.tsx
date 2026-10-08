import { SkeletonCard, SkeletonPill } from "@crumb/ui";

export default function Loading() {
  return <SkeletonCard title="Account mapping" after={<SkeletonPill width={80} />} lines={5} />;
}
