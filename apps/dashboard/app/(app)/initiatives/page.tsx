import { Suspense } from "react";
import { PageHead } from "@crumb/ui";
import { getActiveSession } from "@/lib/server";
import { NewInitiativeForm } from "./NewInitiativeForm";
import { InitiativesBoardTile } from "./InitiativesBoardTile";
import { InitiativesTableSkeleton } from "./InitiativesTableSkeleton";

export const dynamic = "force-dynamic";
export const metadata = { title: "Initiatives" };

export default async function InitiativesListPage() {
  // Session check is fast (cookie + sessions table) and gates the
  // "+ New initiative" button visibility. The heavy query stays inside
  // the suspended board tile.
  const { user } = await getActiveSession();
  const canManage = user.role === "admin" || user.role === "pm";

  return (
    <>
      <PageHead
        crumb="Initiatives"
        title="Initiatives"
        lede="Group feedback into themed buckets, then move them across Now, Next and Later, and into Shipped, to shape the roadmap. Public ones show in the widget once they're scheduled or shipped."
        actions={canManage ? <NewInitiativeForm /> : null}
      />
      <Suspense fallback={<InitiativesTableSkeleton />}>
        <InitiativesBoardTile />
      </Suspense>
    </>
  );
}
