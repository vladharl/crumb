import { PageHead, SkeletonPill } from "@crumb/ui";
import { InboxTableSkeleton } from "./InboxTableSkeleton";

// The page's own head, word for word (inbox/page.tsx), so nothing above the
// table moves when the real page lands.
export default function Loading() {
  return (
    <>
      <PageHead
        crumb="Daily"
        title="Inbox"
        lede="Every loop customers have opened, starting with the ones waiting on you."
        actions={<SkeletonPill width={92} />}
      />
      <InboxTableSkeleton />
    </>
  );
}
