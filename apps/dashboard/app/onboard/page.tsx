import { redirect } from "next/navigation";
import { db, workspaceUsers } from "@crumb/db";
import { BrandMark } from "@crumb/ui";
import { OnboardForm } from "./OnboardForm";

export const dynamic = "force-dynamic";

async function isFirstRun(): Promise<boolean> {
  const [row] = await db.select({ id: workspaceUsers.id }).from(workspaceUsers).limit(1);
  return !row;
}

export default async function OnboardPage() {
  if (!(await isFirstRun())) redirect("/login");

  return (
    <main style={{
      background: "var(--cream)",
      minHeight: "100vh",
      display: "grid",
      placeItems: "center",
      padding: 16,
    }}>
      <div className="card" style={{ width: 440, maxWidth: "calc(100vw - 32px)", padding: 28 }}>
        <div className="col gap-4">
          <div className="row gap-3 center">
            <BrandMark width={36} height={36} />
            <div className="col">
              <span className="serif" style={{ fontSize: 22, lineHeight: 1.05 }}>Welcome to Crumb</span>
              <span className="text-xs muted">Set up your workspace.</span>
            </div>
          </div>

          <hr className="divider" />

          <p className="text-sm muted" style={{ margin: 0, lineHeight: 1.55 }}>
            No workspaces exist yet on this Crumb instance. The first person here becomes the admin (you). Add teammates after.
          </p>

          <OnboardForm />
        </div>
      </div>
    </main>
  );
}
