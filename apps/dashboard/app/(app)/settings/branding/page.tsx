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
      initialPosition={(["corner", "pill", "tab"].includes(ws.position) ? ws.position : "corner") as "corner" | "pill" | "tab"}
      initialGlass={ws.launcherGlass}
      initialVisibility={(["auto", "always", "hidden"].includes(ws.launcherVisibility) ? ws.launcherVisibility : "auto") as "auto" | "always" | "hidden"}
      initialOffsetX={ws.launcherOffsetX ?? 0}
      initialOffsetY={ws.launcherOffsetY ?? 0}
      initialProductUrl={ws.productUrl}
    />
  );
}
