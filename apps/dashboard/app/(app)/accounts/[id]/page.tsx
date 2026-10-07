import { Suspense } from "react";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, accounts } from "@crumb/db";
import { getSession } from "@/lib/auth";
import { AccountHeroTile } from "./AccountHeroTile";
import { AccountFeedbackTile } from "./AccountFeedbackTile";
import { AccountSidebarTile } from "./AccountSidebarTile";
import { AccountUsageTile } from "./AccountUsageTile";
import { AccountSessionsTile } from "./AccountSessionsTile";
// AccountChannelsTile (customer Slack/Teams webhooks) is intentionally unmounted —
// there's no customer self-serve surface yet, so the vendor-side config is hidden.
// The component, its action, and the send path remain in place but dormant.
import { AccountFeedbackSkeleton, AccountHeroSkeleton, AccountSessionsSkeleton, AccountSidebarSkeleton } from "./AccountSkeletons";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tab title is the account name. The id is checked before the query because
// Postgres throws on a malformed uuid, and generateMetadata must never throw.
export async function generateMetadata({ params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return {}; // the layout is about to redirect to /login
  if (!UUID_RE.test(params.id)) return { title: "Not found" };
  const [account] = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.workspaceId, session.workspace.id), eq(accounts.id, params.id)))
    .limit(1);
  return { title: account?.name ?? "Not found" };
}

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
        </div>
      </div>
    </>
  );
}
