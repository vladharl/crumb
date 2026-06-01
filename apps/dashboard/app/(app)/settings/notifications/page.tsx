import { Suspense } from "react";
import { NotificationsSidebarTile } from "../../notifications/NotificationsSidebarTile";
import { NotificationsSidebarSkeleton } from "../../notifications/NotificationsSkeletons";

export const dynamic = "force-dynamic";

// Notification preferences live in Settings now (the feed moved to the top-bar
// bell). Reuses the existing preferences + digest-preview tile.
export default function SettingsNotificationsPage() {
  return (
    <Suspense fallback={<NotificationsSidebarSkeleton />}>
      <NotificationsSidebarTile />
    </Suspense>
  );
}
