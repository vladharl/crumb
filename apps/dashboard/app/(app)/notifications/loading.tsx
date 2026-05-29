import { PageHead } from "@crumb/ui";
import { NotificationsFeedSkeleton, NotificationsSidebarSkeleton } from "./NotificationsSkeletons";

export default function Loading() {
  return (
    <>
      <PageHead
        crumb="Daily"
        title="Notifications"
        lede="Everything that's happened across your customers — and how you want to be told about it."
      />
      <div className="cols-2-1" style={{ alignItems: "start" }}>
        <NotificationsFeedSkeleton />
        <NotificationsSidebarSkeleton />
      </div>
    </>
  );
}
