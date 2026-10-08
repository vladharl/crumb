import { Card, PageHead, Pill } from "@crumb/ui";
import { getActiveSession } from "@/lib/server";
import { isCloud } from "@/lib/tier";
import { hasFeature, usageAnalyticsAllowed } from "@/lib/entitlements";
import { AskBox } from "./AskBox";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ask" };

// "Ask your feedback" (feature 5). Semantic Q&A over the corpus with cited
// answers. AI-gated (Cloud + plan); self-host sees an upsell/disabled state.
export default async function AskPage() {
  const { workspace } = await getActiveSession();
  const aiEnabled = hasFeature(workspace, "ai");
  // Usage mode needs both the AI stack and the usage_analytics entitlement.
  const usageEnabled = aiEnabled && usageAnalyticsAllowed(workspace);

  return (
    <>
      <PageHead
        crumb="Ask"
        title="Ask your feedback"
        lede="Ask questions in plain language and get answers grounded in your feedback, with citations."
        actions={<Pill ring>{aiEnabled ? "AI" : "Cloud"}</Pill>}
      />

      {aiEnabled ? (
        <AskBox usageEnabled={usageEnabled} />
      ) : (
        <Card>
          <div className="card-body col gap-2">
            <p className="text-sm note">
              {isCloud()
                ? <>Ask your feedback is part of the AI features on the Team and Growth plans. Upgrade from <a href="/settings/billing" style={{ color: "var(--ink)" }}>Settings → Billing</a> to interrogate your whole corpus in seconds.</>
                : <>Ask your feedback runs on Crumb Cloud (it needs the managed AI + embeddings stack). It's not available on self-host builds.</>}
            </p>
          </div>
        </Card>
      )}
    </>
  );
}
