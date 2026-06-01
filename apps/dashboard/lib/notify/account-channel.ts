import "server-only";
import { eq } from "drizzle-orm";
import { db, accounts } from "@crumb/db";
import { open } from "@/lib/crypto-at-rest";
import { postSlackWebhook, postTeamsWebhook, slackBlocksFor, teamsCardFor, type ChatEvent } from "./chat";
import { log } from "@/lib/log";

// Customer-side: post a card to the account's own Slack/Teams channel webhook
// (if set), respecting the per-account toggle. Runs ALONGSIDE the existing
// customer email — never replaces it. Best-effort.
export async function notifyAccountChannels(
  accountId: string,
  event: ChatEvent,
  gate: "replies" | "status" | "roadmap",
): Promise<void> {
  try {
    const [a] = await db
      .select({
        slackWebhookUrl: accounts.slackWebhookUrl,
        teamsWebhookUrl: accounts.teamsWebhookUrl,
        notifyChatReplies: accounts.notifyChatReplies,
        notifyChatStatus: accounts.notifyChatStatus,
        notifyChatRoadmap: accounts.notifyChatRoadmap,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (!a) return;

    const enabled = gate === "replies" ? a.notifyChatReplies : gate === "status" ? a.notifyChatStatus : a.notifyChatRoadmap;
    if (!enabled) return;

    if (a.slackWebhookUrl) {
      let url: string | null = null;
      try { url = open(a.slackWebhookUrl); } catch { url = null; }
      if (url) {
        const r = await postSlackWebhook(url, slackBlocksFor(event));
        if (!r.ok) log.warn("account slack webhook failed", { scope: "crumb/notify", error: r.error });
      }
    }
    if (a.teamsWebhookUrl) {
      let url: string | null = null;
      try { url = open(a.teamsWebhookUrl); } catch { url = null; }
      if (url) {
        const r = await postTeamsWebhook(url, teamsCardFor(event));
        if (!r.ok) log.warn("account teams webhook failed", { scope: "crumb/notify", error: r.error });
      }
    }
  } catch (err) {
    log.error("notifyAccountChannels failed", { scope: "crumb/notify", err });
  }
}
