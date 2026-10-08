import { SkeletonCard } from "@crumb/ui";

// page.tsx's first two cards: Try it, then the install snippet.
export default function Loading() {
  return (
    <>
      <SkeletonCard title="Try it" lines={3} />
      <SkeletonCard title="Install the widget" lines={6} />
    </>
  );
}
