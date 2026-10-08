import { PageHead, SkeletonPill } from "@crumb/ui";
import { InitiativesTableSkeleton } from "./InitiativesTableSkeleton";

export default function Loading() {
  return (
    <>
      <PageHead
        crumb="Initiatives"
        title="Initiatives"
        // Word for word from initiatives/page.tsx, so the head doesn't reflow.
        lede="Group feedback into themed buckets, then move them across Now, Next and Later, and into Shipped, to shape the roadmap. Public ones show in the widget once they're scheduled or shipped."
        actions={<SkeletonPill width={110} />}
      />
      <InitiativesTableSkeleton />
    </>
  );
}
