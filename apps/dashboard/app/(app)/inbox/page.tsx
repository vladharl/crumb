import { Suspense } from "react";
import { PageHead, SkeletonPill } from "@crumb/ui";
import { InboxTableTile } from "./InboxTableTile";
import { InboxTableSkeleton } from "./InboxTableSkeleton";
import { ComposeActionsTile } from "./ComposeActionsTile";

export const dynamic = "force-dynamic";

export default function InboxPage() {
  return (
    <>
      <PageHead
        crumb="Daily"
        title="Inbox"
        lede="Every loop customers have opened, starting with the ones waiting on you."
        actions={
          <Suspense fallback={<SkeletonPill width={92} />}>
            <ComposeActionsTile />
          </Suspense>
        }
      />
      <Suspense fallback={<InboxTableSkeleton />}>
        <InboxTableTile />
      </Suspense>
    </>
  );
}
