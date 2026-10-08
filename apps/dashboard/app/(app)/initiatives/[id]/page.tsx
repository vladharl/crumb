import { Suspense } from "react";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, initiatives } from "@crumb/db";
import { getSession } from "@/lib/auth";
import { InitiativeHeaderTile } from "./InitiativeHeaderTile";
import { InitiativeImpactTile } from "./InitiativeImpactTile";
import { InitiativeFeedbackTile } from "./InitiativeFeedbackTile";
import { InitiativeHeaderSkeleton, InitiativeFeedbackSkeleton } from "./InitiativeSkeletons";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tab title is the initiative name. The id is checked before the query because
// Postgres throws on a malformed uuid, and generateMetadata must never throw.
export async function generateMetadata({ params }: { params: { id: string } }) {
  const session = await getSession();
  if (!session) return {}; // the layout is about to redirect to /login
  if (!UUID_RE.test(params.id)) return { title: "Not found" };
  const [initiative] = await db
    .select({ name: initiatives.name })
    .from(initiatives)
    .where(and(eq(initiatives.workspaceId, session.workspace.id), eq(initiatives.id, params.id)))
    .limit(1);
  return { title: initiative?.name ?? "Not found" };
}

export default function InitiativeDetailPage({ params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) notFound();
  return (
    <>
      <Suspense fallback={<InitiativeHeaderSkeleton />}>
        <InitiativeHeaderTile id={params.id} />
      </Suspense>
      <Suspense fallback={null}>
        <InitiativeImpactTile id={params.id} />
      </Suspense>
      <Suspense fallback={<InitiativeFeedbackSkeleton />}>
        <InitiativeFeedbackTile id={params.id} />
      </Suspense>
    </>
  );
}
