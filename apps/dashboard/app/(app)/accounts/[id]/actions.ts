"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, accounts } from "@crumb/db";
import { getActiveSession } from "@/lib/server";
import { seal, open } from "@/lib/crypto-at-rest";
import { assertSafeWebhookUrl } from "@/lib/notify/url-guard";
import { postSlackWebhook, postTeamsWebhook, slackBlocksFor, teamsCardFor } from "@/lib/notify/chat";

function canManage(role: string): boolean {
  return role === "admin" || role === "pm";
}

export type ChannelsResult = { ok: true } | { ok: false; error: string };

// Set a customer account's Slack/Teams channel webhooks (sealed) + toggles.
// Partial update: `undefined` leaves a URL untouched; null/"" clears it; a
// non-empty value is validated (SSRF guard) + sealed.
export async function setAccountChannels(
  accountId: string,
  input: {
    slackWebhookUrl?: string | null;
    teamsWebhookUrl?: string | null;
    notifyChatReplies?: boolean;
    notifyChatStatus?: boolean;
    notifyChatRoadmap?: boolean;
  },
): Promise<ChannelsResult> {
  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  const set: Partial<typeof accounts.$inferInsert> = {};
  for (const key of ["slackWebhookUrl", "teamsWebhookUrl"] as const) {
    const v = input[key];
    if (v === undefined) continue;
    if (v === null || v === "") { set[key] = null; continue; }
    const guard = assertSafeWebhookUrl(v);
    if (!guard.ok) return { ok: false, error: "invalid_url" };
    set[key] = seal(guard.url);
  }
  if (input.notifyChatReplies !== undefined) set.notifyChatReplies = input.notifyChatReplies;
  if (input.notifyChatStatus !== undefined) set.notifyChatStatus = input.notifyChatStatus;
  if (input.notifyChatRoadmap !== undefined) set.notifyChatRoadmap = input.notifyChatRoadmap;

  if (Object.keys(set).length === 0) return { ok: true };
  await db.update(accounts).set(set).where(and(eq(accounts.workspaceId, workspace.id), eq(accounts.id, accountId)));
  revalidatePath(`/accounts/${accountId}`);
  return { ok: true };
}

export async function testAccountChannel(accountId: string, provider: "slack" | "teams"): Promise<ChannelsResult> {
  const { workspace, user } = await getActiveSession();
  if (!canManage(user.role)) return { ok: false, error: "forbidden" };

  const [a] = await db
    .select({ slackWebhookUrl: accounts.slackWebhookUrl, teamsWebhookUrl: accounts.teamsWebhookUrl })
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspace.id), eq(accounts.id, accountId)))
    .limit(1);
  if (!a) return { ok: false, error: "not_found" };

  const sealed = provider === "slack" ? a.slackWebhookUrl : a.teamsWebhookUrl;
  if (!sealed) return { ok: false, error: "not_connected" };
  let url: string;
  try { url = open(sealed); } catch { return { ok: false, error: "decrypt_failed" }; }

  const event = {
    kind: "status_change" as const,
    shortId: "FB-0",
    title: "Crumb test card",
    fromStatus: null,
    toStatus: "open",
    reason: "This is a test from Crumb.",
    url: null,
  };
  const r = provider === "slack"
    ? await postSlackWebhook(url, slackBlocksFor(event))
    : await postTeamsWebhook(url, teamsCardFor(event));
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? "post_failed" };
}
