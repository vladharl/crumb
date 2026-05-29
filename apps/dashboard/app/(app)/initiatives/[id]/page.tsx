import { Suspense } from "react";
import { notFound } from "next/navigation";
import { InitiativeHeaderTile } from "./InitiativeHeaderTile";
import { InitiativeFeedbackTile } from "./InitiativeFeedbackTile";
import { InitiativeHeaderSkeleton, InitiativeFeedbackSkeleton } from "./InitiativeSkeletons";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function InitiativeDetailPage({ params }: { params: { id: string } }) {
  if (!UUID_RE.test(params.id)) notFound();
  return (
    <>
      <Suspense fallback={<InitiativeHeaderSkeleton />}>
        <InitiativeHeaderTile id={params.id} />
      </Suspense>
      <Suspense fallback={<InitiativeFeedbackSkeleton />}>
        <InitiativeFeedbackTile id={params.id} />
      </Suspense>
    </>
  );
}
