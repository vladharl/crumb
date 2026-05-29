import { Suspense } from "react";
import { PageHead } from "@crumb/ui";
import { getActiveSession } from "@/lib/server";
import { NewInitiativeForm } from "./NewInitiativeForm";
import { InitiativesTableTile } from "./InitiativesTableTile";
import { InitiativesTableSkeleton } from "./InitiativesTableSkeleton";

export const dynamic = "force-dynamic";

export default async function InitiativesListPage() {
  // Session check is fast (cookie + sessions table) and gates the
  // "+ New initiative" button visibility. The heavy query (with its
  // per-row count subqueries) stays inside the suspended tile.
  const { user } = await getActiveSession();
  const canManage = user.role === "admin" || user.role === "pm";

  return (
    <>
      <PageHead
        crumb="Initiatives"
        title="Initiatives"
        lede="Group inbound feedback into themed buckets — User Management, Reporting, Mobile, anything that helps you triage at a glance."
        actions={canManage ? <NewInitiativeForm /> : null}
      />
      <Suspense fallback={<InitiativesTableSkeleton />}>
        <InitiativesTableTile />
      </Suspense>
    </>
  );
}
