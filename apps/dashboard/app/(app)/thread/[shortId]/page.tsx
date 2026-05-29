import { Suspense } from "react";
import { ThreadViewTile } from "./ThreadViewTile";
import { ThreadSkeleton } from "./ThreadSkeleton";

export const dynamic = "force-dynamic";

export default function ThreadPage({ params }: { params: { shortId: string } }) {
  return (
    <Suspense fallback={<ThreadSkeleton shortId={params.shortId} />}>
      <ThreadViewTile shortId={params.shortId} />
    </Suspense>
  );
}
