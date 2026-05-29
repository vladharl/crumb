import { PageHead, SkeletonPill } from "@crumb/ui";
import { InboxTableSkeleton } from "./InboxTableSkeleton";

export default function Loading() {
  return (
    <>
      <PageHead
        crumb="Daily"
        title="Inbox"
        lede="Everything customers have sent — newest first."
        actions={<SkeletonPill width={92} />}
      />
      <InboxTableSkeleton />
    </>
  );
}
