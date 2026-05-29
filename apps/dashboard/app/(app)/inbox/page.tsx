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
        lede="Everything customers have sent — newest first."
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
