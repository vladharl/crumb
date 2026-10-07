import { getActiveWorkspace } from "@/lib/server";
import { BrandingCard } from "./BrandingCard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Branding · Settings" };

export default async function BrandingPage() {
  const ws = await getActiveWorkspace();
  return (
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
  );
}
