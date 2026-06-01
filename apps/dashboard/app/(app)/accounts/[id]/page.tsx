import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AccountHeroTile } from "./AccountHeroTile";
import { AccountFeedbackTile } from "./AccountFeedbackTile";
import { AccountSidebarTile } from "./AccountSidebarTile";
import { AccountUsageTile } from "./AccountUsageTile";
import { AccountSessionsTile } from "./AccountSessionsTile";
import { AccountChannelsTile } from "./AccountChannelsTile";
import { AccountFeedbackSkeleton, AccountHeroSkeleton, AccountSessionsSkeleton, AccountSidebarSkeleton } from "./AccountSkeletons";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function AccountDetailPage({ params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) notFound();

  return (
    <>
      <Suspense fallback={<AccountHeroSkeleton />}>
        <AccountHeroTile accountId={params.id} />
      </Suspense>

      <div className="cols-2-1">
        <Suspense fallback={<AccountFeedbackSkeleton />}>
          <AccountFeedbackTile accountId={params.id} />
        </Suspense>

        <div className="col gap-4">
          <Suspense fallback={<AccountSidebarSkeleton />}>
            <AccountSidebarTile accountId={params.id} />
          </Suspense>
          <Suspense fallback={null}>
            <AccountUsageTile accountId={params.id} />
          </Suspense>
          <Suspense fallback={<AccountSessionsSkeleton />}>
            <AccountSessionsTile accountId={params.id} />
          </Suspense>
          <Suspense fallback={null}>
            <AccountChannelsTile accountId={params.id} />
          </Suspense>
        </div>
      </div>
    </>
  );
}
