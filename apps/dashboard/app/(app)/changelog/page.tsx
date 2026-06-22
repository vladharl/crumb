import { Suspense } from "react";
import { PageHead, SkeletonPill } from "@crumb/ui";
import { ChangelogTile } from "./ChangelogTile";

export const dynamic = "force-dynamic";

export default function ChangelogPage() {
  return (
    <>
      <PageHead
        crumb="Changelog"
        title="Changelog"
        lede="Announce what shipped. When an initiative ships, Crumb drafts an entry here — publish it and everyone who asked hears the outcome."
      />
      <Suspense fallback={<SkeletonPill width={120} />}>
        <ChangelogTile />
      </Suspense>
    </>
  );
}
