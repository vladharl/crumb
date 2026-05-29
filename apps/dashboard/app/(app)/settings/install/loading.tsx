import { SkeletonCard } from "@crumb/ui";

export default function Loading() {
  return (
    <>
      <SkeletonCard title="Install the widget" lines={4} />
      <SkeletonCard title="Signing secret" lines={2} />
    </>
  );
}
