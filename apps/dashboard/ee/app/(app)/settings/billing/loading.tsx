import { SkeletonCard, SkeletonPill } from "@crumb/ui";

export default function Loading() {
  return <SkeletonCard title="Billing" after={<SkeletonPill width={72} />} lines={4} />;
}
