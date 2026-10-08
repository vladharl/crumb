import { headers } from "next/headers";
import { getActiveSession } from "@/lib/server";
import { originFromHeaders } from "@/lib/origin";
import { RESERVED_SLUGS } from "@/lib/provision";
import { BrandingCard } from "./BrandingCard";
import { PublicPagesCard } from "./PublicPagesCard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Branding · Settings" };

export default async function BrandingPage() {
  const { workspace: ws, user } = await getActiveSession();
  const pages = `${originFromHeaders(headers()) ?? ""}/${ws.slug}`;
  return (
    <>
      <BrandingCard
        initialName={ws.name}
        initialAccent={ws.accent}
        initialLauncherBg={ws.launcherBg}
        initialEdge={(["right", "left"].includes(ws.launcherEdge) ? ws.launcherEdge : "right") as "right" | "left"}
        // A saved "always" behaves as "auto" in the widget: both read as Shown.
        initialVisibility={ws.launcherVisibility === "hidden" ? "hidden" : "auto"}
        initialOffsetY={ws.launcherOffsetY ?? 0}
        initialProductUrl={ws.productUrl}
      />
      <PublicPagesCard
        enabled={ws.publicPagesEnabled}
        isAdmin={user.role === "admin"}
        // A slug from before the reserved list (lib/provision): the app's own
        // routes answer /<slug>/roadmap there, now or later, so no links.
        addressTaken={RESERVED_SLUGS.has(ws.slug)}
        roadmapUrl={`${pages}/roadmap`}
        changelogUrl={`${pages}/changelog`}
      />
    </>
  );
}
