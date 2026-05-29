import { PageHead, SkeletonPill } from "@crumb/ui";
import { InitiativesTableSkeleton } from "./InitiativesTableSkeleton";

export default function Loading() {
  return (
    <>
      <PageHead
        crumb="Initiatives"
        title="Initiatives"
        lede="Group inbound feedback into themed buckets — User Management, Reporting, Mobile, anything that helps you triage at a glance."
        actions={<SkeletonPill width={110} />}
      />
      <InitiativesTableSkeleton />
    </>
  );
}
