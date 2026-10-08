import { Suspense } from "react";
import { PageHead, SkeletonPill } from "@crumb/ui";
import { ChangelogTile } from "./ChangelogTile";

export const dynamic = "force-dynamic";
export const metadata = { title: "Changelog" };

export default function ChangelogPage() {
  return (
    <>
      <PageHead
        crumb="Changelog"
        title="Changelog"
        lede="Announce what shipped. When an initiative ships, Crumb drafts an entry here. Publish it and everyone who asked for it or follows it hears the outcome. Entries you write yourself appear in the changelog and only go to people following your public changelog."
      />
      <Suspense fallback={<SkeletonPill width={120} />}>
        <ChangelogTile />
      </Suspense>
    </>
  );
}
