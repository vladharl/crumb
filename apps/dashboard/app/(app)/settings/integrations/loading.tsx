import { SkeletonCard, SkeletonPill } from "@crumb/ui";

// The page's first cards as themselves (page.tsx order): title, state pill,
// the description and the Connect row.
export default function Loading() {
  return (
    <>
      {["Linear", "Jira", "GitHub"].map(title => (
        <SkeletonCard key={title} title={title} after={<SkeletonPill width={92} />} lines={3} />
      ))}
    </>
  );
}
