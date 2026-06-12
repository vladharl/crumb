import { getActiveWorkspace } from "@/lib/server";
import { BrandingCard } from "./BrandingCard";

export const dynamic = "force-dynamic";

export default async function BrandingPage() {
  const ws = await getActiveWorkspace();
  return (
    <BrandingCard
      initialName={ws.name}
      initialAccent={ws.accent}
      initialLauncherBg={ws.launcherBg}
      initialEdge={(["right", "left"].includes(ws.launcherEdge) ? ws.launcherEdge : "right") as "right" | "left"}
      initialVisibility={(["auto", "always", "hidden"].includes(ws.launcherVisibility) ? ws.launcherVisibility : "auto") as "auto" | "always" | "hidden"}
      initialOffsetY={ws.launcherOffsetY ?? 0}
      initialProductUrl={ws.productUrl}
    />
  );
}
