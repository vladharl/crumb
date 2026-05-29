import { Suspense } from "react";
import { PageHead } from "@crumb/ui";
import { NotificationsFeedTile } from "./NotificationsFeedTile";
import { NotificationsSidebarTile } from "./NotificationsSidebarTile";
import { NotificationsFeedSkeleton, NotificationsSidebarSkeleton } from "./NotificationsSkeletons";

export const dynamic = "force-dynamic";

export default function NotificationsPage() {
  return (
    <>
      <PageHead
        crumb="Daily"
        title="Notifications"
        lede="Everything that's happened across your customers — and how you want to be told about it."
      />
      <div className="cols-2-1" style={{ alignItems: "start" }}>
        <Suspense fallback={<NotificationsFeedSkeleton />}>
          <NotificationsFeedTile />
        </Suspense>

        <Suspense fallback={<NotificationsSidebarSkeleton />}>
          <NotificationsSidebarTile />
        </Suspense>
      </div>
    </>
  );
}
