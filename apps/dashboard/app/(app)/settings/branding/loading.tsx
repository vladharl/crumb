import { SkeletonCard } from "@crumb/ui";

export default function Loading() {
  return (
    <>
      <SkeletonCard title="Branding" lines={4} />
      <SkeletonCard title="Widget preview" lines={3} />
    </>
  );
}
