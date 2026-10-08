import { Card, PageHead, Pill } from "@crumb/ui";
import { getActiveSession } from "@/lib/server";
import { isCloud } from "@/lib/tier";
import { hasFeature, usageAnalyticsAllowed, workspacePlan } from "@/lib/entitlements";
import { getAiUsage } from "@/lib/usage";
import { AiUsageNotice, UpgradeNotice } from "@/components/UpgradeNotice";
import { AskBox } from "./AskBox";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ask" };

// "Ask your feedback" (feature 5). Semantic Q&A over the corpus with cited
// answers. AI-gated (Cloud + plan); self-host sees an upsell/disabled state.
export default async function AskPage() {
  const { workspace, user } = await getActiveSession();
  const isAdmin = user.role === "admin";
  const aiEnabled = hasFeature(workspace, "ai");
  // Usage mode needs both the AI stack and the usage_analytics entitlement.
  const usageEnabled = aiEnabled && usageAnalyticsAllowed(workspace);
  // This month's AI budget: a banner from 80%, plus the "paused" notice AskBox
  // swaps in if a question hits the cap mid-visit.
  const usage = await getAiUsage(workspace);
  const plan = workspacePlan(workspace);

  return (
    <>
      <PageHead
        crumb="Ask"
        title="Ask your feedback"
        lede="Ask questions in plain language and get answers grounded in your feedback, with citations."
        actions={<Pill ring>{aiEnabled ? "AI" : "Cloud"}</Pill>}
      />

      {aiEnabled ? (
        <AskBox
          usageEnabled={usageEnabled}
          notice={usage && <AiUsageNotice percent={usage.percent} resetsAt={usage.resetsAt} isAdmin={isAdmin} plan={plan} />}
          capNotice={usage && <AiUsageNotice percent={100} resetsAt={usage.resetsAt} isAdmin={isAdmin} plan={plan} />}
        />
      ) : isCloud() ? (
        <UpgradeNotice feature="ai" isAdmin={isAdmin} />
      ) : (
        <Card>
          <div className="card-body col gap-2">
            <p className="text-sm note">
              Ask your feedback runs on Crumb Cloud (it needs the managed AI + embeddings stack). It's not available on self-host builds.
            </p>
          </div>
        </Card>
      )}
    </>
  );
}
