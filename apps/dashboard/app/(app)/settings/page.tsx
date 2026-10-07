import { getActiveSession } from "@/lib/server";
import { SetupChecklist } from "@/components/SetupChecklist";
import { EmailDeliveryCard } from "./EmailDeliveryCard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

/**
 * Settings landing: setup state at a glance instead of a redirect to Team. The
 * checklist (components/SetupChecklist, also on a new workspace's inbox), then
 * the email card its email step links to.
 */
export default async function SettingsOverview() {
  const { workspace, user } = await getActiveSession();
  const isAdmin = user.role === "admin";

  return (
    <>
      <SetupChecklist workspace={workspace} isAdmin={isAdmin} />
      {/* Anchor for the checklist's email step; the margin clears the sticky topbar. */}
      <div id="email-delivery" style={{ scrollMarginTop: 72 }}>
        <EmailDeliveryCard isAdmin={isAdmin} />
      </div>
    </>
  );
}
