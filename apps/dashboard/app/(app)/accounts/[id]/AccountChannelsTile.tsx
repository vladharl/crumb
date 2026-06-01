import { and, eq } from "drizzle-orm";
import { Card, CardHead } from "@crumb/ui";
import { db, accounts } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { AccountChannelsForm } from "./AccountChannelsForm";

// DORMANT: intentionally not rendered (removed from accounts/[id]/page.tsx).
// Kept on disk with its action + send path until there's a customer self-serve
// surface to configure these webhooks. See the plan / commit that hid it.
//
// "Customer notifications" card — the customer account's own Slack/Teams channel
// webhooks. We never echo the sealed secret; only whether it's configured.
export async function AccountChannelsTile({ accountId }: { accountId: string }) {
  const { workspace, user } = await getActiveSession();
  const [a] = await db
    .select({
      slackWebhookUrl: accounts.slackWebhookUrl,
      teamsWebhookUrl: accounts.teamsWebhookUrl,
      notifyChatReplies: accounts.notifyChatReplies,
      notifyChatStatus: accounts.notifyChatStatus,
      notifyChatRoadmap: accounts.notifyChatRoadmap,
    })
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspace.id), eq(accounts.id, accountId)))
    .limit(1);
  if (!a) return null;

  const canWrite = user.role === "admin" || user.role === "pm";
  return (
    <Card>
      <CardHead title="Customer notifications" />
      <div className="card-body col gap-3">
        <p className="text-xs muted" style={{ margin: 0, lineHeight: 1.55 }}>
          Post replies, status changes, and roadmap updates to this customer's own Slack or Teams channel (in addition to email). Paste a channel incoming-webhook URL.
        </p>
        <AccountChannelsForm
          accountId={accountId}
          canWrite={canWrite}
          initial={{
            slackSet: !!a.slackWebhookUrl,
            teamsSet: !!a.teamsWebhookUrl,
            notifyChatReplies: a.notifyChatReplies,
            notifyChatStatus: a.notifyChatStatus,
            notifyChatRoadmap: a.notifyChatRoadmap,
          }}
        />
      </div>
    </Card>
  );
}
