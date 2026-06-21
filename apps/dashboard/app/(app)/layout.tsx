import type { ReactNode } from "react";
import { requireSession } from "@/lib/auth";
import { hasFeature } from "@/lib/entitlements";
import { supportContactEnabled } from "@/lib/email";
import { AppShell } from "./AppShell";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { workspace, user } = await requireSession();
  return (
    <AppShell
      user={{
        name: user.name,
        email: user.email,
        initials: user.initials,
        workspaceName: workspace.name,
      }}
      aiEnabled={hasFeature(workspace, "ai")}
      tourDone={user.guideCompletedAt != null}
      supportEnabled={supportContactEnabled()}
    >
      {children}
    </AppShell>
  );
}
