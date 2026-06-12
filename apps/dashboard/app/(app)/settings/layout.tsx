import type { ReactNode } from "react";
import { PageHead } from "@crumb/ui";
import { getActiveSession } from "@/lib/server";
import { SettingsNav } from "./SettingsNav";

export const dynamic = "force-dynamic";

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const { workspace } = await getActiveSession();
  return (
    <>
      <PageHead
        crumb="Settings"
        title="Workspace"
        lede={`${workspace.name} · set up the widget, connect your tools, run the workspace.`}
      />
      <div className="cols-aside">
        <SettingsNav />
        <div className="col gap-5">{children}</div>
      </div>
    </>
  );
}
