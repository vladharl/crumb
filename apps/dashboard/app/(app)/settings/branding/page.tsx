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
      initialPosition={ws.position as "corner" | "top" | "inline"}
      initialProductUrl={ws.productUrl}
    />
  );
}
