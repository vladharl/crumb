import { SkeletonCard } from "@crumb/ui";

export default function Loading() {
  return (
    <>
      <SkeletonCard title="Try it" lines={2} />
      <SkeletonCard title="Install the widget" lines={4} />
    </>
  );
}
