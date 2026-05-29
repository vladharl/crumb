import { AccountFeedbackSkeleton, AccountHeroSkeleton, AccountSidebarSkeleton } from "./AccountSkeletons";

export default function Loading() {
  return (
    <>
      <AccountHeroSkeleton />
      <div className="cols-2-1">
        <AccountFeedbackSkeleton />
        <AccountSidebarSkeleton />
      </div>
    </>
  );
}
