import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, accounts, accountUsers } from "@crumb/db";
import { CLOSED_STATUSES } from "@crumb/ui";
import { verifySlackSignature } from "@/lib/slack/verify";
import { sendDirectMessage, slackTeammate, escapeSlackText } from "@/lib/slack/notify";
import { workspaceForSlackTeam } from "@/lib/slack/install";
import { open } from "@/lib/crypto-at-rest";
import { withAiBudget } from "@/lib/ai/run";
import { embedText } from "@/lib/ai/embeddings";
import { findDuplicatesForVector } from "@/lib/ai/dedup";
import { suggestAccount } from "@/lib/ai/match-account";
import { sizeRequest, type SizeRequestResult } from "@/lib/ai/size-request";
import { getRepoContext } from "@/lib/integrations/github";
import { formatArr } from "@/lib/priority";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/integrations/slack/events — the Slack Events API endpoint. Phase-0
// sizing bot: when a teammate @mentions the Crumb bot on a message in a feedback
// channel, we reply, to them only, sizing the request (what it is, revenue at
// stake, T-shirt scope). Reply-only — nothing is written to items/captures.
//
// Slack requires an ack within 3s, so we verify + ack immediately and do all
// DB/AI work in a fire-and-forget promise (the same post-response pattern as
// app/api/v1/items/route.ts; the Node server is persistent under docker-compose
// so the promise runs to completion).
export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySlackSignature(raw, req.headers.get("x-slack-request-timestamp"), req.headers.get("x-slack-signature"))) {
    return new NextResponse("invalid signature", { status: 401 });
  }

  let body: SlackEnvelope;
  try {
    body = JSON.parse(raw) as SlackEnvelope;
  } catch {
    return new NextResponse("", { status: 200 });
  }

  // Event Subscriptions handshake (fired when the Request URL is saved).
  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  // ponytail: skip Slack retries by header, not an event_id store — we ack in
  // ms, so a retry means a transient network blip, not a missed event, and
  // skipping it prevents a duplicate reply. Add persistent event_id dedup if
  // double-replies are ever observed.
  if (req.headers.get("x-slack-retry-num")) {
    return new NextResponse("", { status: 200 });
  }

  const event = body.event;
  if (body.type === "event_callback" && event?.type === "app_mention" && !event.bot_id) {
    void processAppMention(body.team_id, event);
  }

  return new NextResponse("", { status: 200 });
}

type SlackMentionEvent = {
  type: string;
  user?: string;
  // The poster's Slack team: user_team in shared (Slack Connect) channels,
  // team on user messages generally.
  user_team?: string;
  team?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
};

type SlackEnvelope = {
  type?: string;
  challenge?: string;
  team_id?: string;
  event?: SlackMentionEvent;
};

async function processAppMention(teamId: string | undefined, event: SlackMentionEvent) {
  try {
    if (!teamId) return;

    const ws = await workspaceForSlackTeam(teamId);
    if (!ws || !ws.slackBotToken) return; // Slack workspace not connected to Crumb

    const botToken = open(ws.slackBotToken);
    if (event.user && event.user === ws.slackBotUserId) return; // ignore our own posts

    const channel = event.channel;
    const mentioner = event.user;
    if (!channel || !mentioner) return;

    // Every reply goes to the mentioner only: the sizing carries requester ARR
    // and other accounts' requests, and anyone in the channel may read a public
    // one, a guest, or the customer in a Slack Connect channel. Slack shows an
    // ephemeral thread reply only in an existing thread, so a top-level mention
    // is answered in the channel, still visible to the mentioner alone.
    const post = (text: string, blocks?: SlackBlock[]) =>
      sendDirectMessage({ botToken, slackUserId: channel, text, blocks, threadTs: event.thread_ts, ephemeralTo: mentioner });

    const teammate = await slackTeammate({
      workspaceId: ws.id,
      installTeamId: teamId,
      botToken,
      slackUserId: mentioner,
      userTeamId: event.user_team ?? event.team,
    });
    if (!teammate) {
      await post("Request sizing is only available to members of this Crumb workspace.");
      return;
    }

    const requestText = stripMentions(event.text ?? "").slice(0, 1500);
    if (!requestText) {
      await post("Mention me on a message that describes a product request and I’ll size it.");
      return;
    }

    const gated = await withAiBudget(ws, () => analyzeAndSize(ws, teammate.email, requestText));
    if (!gated.ok) {
      await post(
        gated.error === "ai_cap_reached"
          ? "This workspace has hit its monthly Crumb AI limit, so sizing is paused until it resets."
          : "Request sizing needs Crumb AI (available on the Cloud plan).",
      );
      return;
    }

    const analysis = gated.value;
    if (!analysis.sizing) {
      await post("Couldn’t size this request right now. Try mentioning me again.");
      return;
    }

    const { text, blocks } = buildSizingBlocks(analysis);
    await post(text, blocks);
  } catch (err) {
    log.error("slack app_mention sizing failed", { scope: "crumb/slack", err });
  }
}

type WsForSizing = {
  id: string;
  githubAppInstallId: string | null;
  githubDefaultRepo: string | null;
};

type Analysis = {
  account: { name: string; arrCents: number } | null;
  similar: { items: Array<{ shortId: string; title: string; status: string }>; combinedArrCents: number; accountCount: number };
  sizing: SizeRequestResult | null;
  repoConnected: boolean;
};

async function analyzeAndSize(
  ws: WsForSizing,
  email: string,
  requestText: string,
): Promise<Analysis> {
  const [account, similar, repoContext] = await Promise.all([
    resolveAccount(ws.id, email, requestText),
    findSimilar(ws.id, requestText),
    ws.githubAppInstallId && ws.githubDefaultRepo
      ? getRepoContext(ws.githubAppInstallId, ws.githubDefaultRepo).catch(() => null)
      : Promise.resolve(null),
  ]);

  const repoConnected = !!(repoContext && (repoContext.readme || repoContext.topLevelTree));

  const sizing = await sizeRequest({
    requestText,
    repoContext: repoContext ?? undefined,
    similar: similar.items.map(i => ({ title: i.title, status: i.status })),
  });

  return { account, similar, sizing, repoConnected };
}

// Mentioner → customer account. Exact email match first; fall back to the
// inbound-capture matcher for internal relays ("Acme wants SSO").
async function resolveAccount(
  workspaceId: string,
  email: string,
  requestText: string,
): Promise<{ name: string; arrCents: number } | null> {
  const [row] = await db
    .select({ name: accounts.name, arrCents: accounts.arrCents })
    .from(accountUsers)
    .innerJoin(accounts, eq(accounts.id, accountUsers.accountId))
    .where(and(eq(accountUsers.workspaceId, workspaceId), sql`lower(${accountUsers.email}) = ${email.toLowerCase()}`))
    .limit(1);
  if (row) return { name: row.name, arrCents: row.arrCents };

  const accountRows = await db
    .select({ id: accounts.id, name: accounts.name, arrCents: accounts.arrCents })
    .from(accounts)
    .where(eq(accounts.workspaceId, workspaceId))
    .limit(200);
  if (accountRows.length === 0) return null;

  const suggestion = await suggestAccount(
    { fromEmail: email, fromName: null, subject: null, body: requestText },
    accountRows.map(a => ({ id: a.id, name: a.name })),
  );
  if (suggestion?.accountId && suggestion.confidence >= 0.7) {
    const a = accountRows.find(x => x.id === suggestion.accountId);
    if (a) return { name: a.name, arrCents: a.arrCents };
  }
  return null;
}

// Similar existing OPEN requests + their combined ARR at stake. Embedding ANN
// over item_embeddings (threshold 0.6 = "similar", not "same"), then the
// inbox's DISTINCT-account ARR rollup over the matched items and any duplicates
// merged into them.
async function findSimilar(
  workspaceId: string,
  requestText: string,
): Promise<Analysis["similar"]> {
  const empty = { items: [], combinedArrCents: 0, accountCount: 0 };
  const vec = await embedText(requestText);
  if (!vec) return empty;

  const candidates = await findDuplicatesForVector({ workspaceId, vec, limit: 5, threshold: 0.6 });
  // Open loops only, by the shared closed set (resolved is closed, Set aside
  // stays open). dedup already drops merged items + 'duplicate'.
  const openCandidates = candidates.filter(c => !CLOSED_STATUSES.has(c.status));
  if (openCandidates.length === 0) return empty;

  const ids = openCandidates.map(c => c.itemId);
  const rows = (await db.execute(sql`
    SELECT COALESCE(SUM(a.arr_cents), 0)::bigint AS combined_arr,
           COUNT(*)::int AS account_count
    FROM (
      SELECT DISTINCT g.account_id FROM items g
      WHERE g.workspace_id = ${workspaceId}
        AND g.account_id IS NOT NULL
        AND (g.id = ANY(${ids}::uuid[]) OR g.merged_into_id = ANY(${ids}::uuid[]))
    ) grp
    JOIN accounts a ON a.id = grp.account_id
  `)) as unknown as Array<{ combined_arr: string | number; account_count: number | string }>;
  const r = rows[0];

  return {
    items: openCandidates.map(c => ({ shortId: c.shortId, title: c.title, status: c.status })),
    combinedArrCents: r ? Number(r.combined_arr) : 0,
    accountCount: r ? Number(r.account_count) : 0,
  };
}

type SlackBlock = Record<string, unknown>;

function buildSizingBlocks(a: Analysis): { text: string; blocks: SlackBlock[] } {
  const s = a.sizing as SizeRequestResult;

  const requesterLine = a.account
    ? `*Requester:* ${escapeSlackText(a.account.name)} (${formatArr(a.account.arrCents, " ARR")})`
    : "*Requester:* no matching account";

  const shown = a.similar.items.slice(0, 3);
  const extra = a.similar.items.length - shown.length;
  const similarLine = a.similar.items.length
    ? `*Similar open requests:* ${shown.map(i => `${i.shortId} “${escapeSlackText(i.title)}”`).join(", ")}${extra > 0 ? ` +${extra} more` : ""} (${a.similar.accountCount} ${a.similar.accountCount === 1 ? "account" : "accounts"}, ${formatArr(a.similar.combinedArrCents, " ARR at stake")})`
    : "*Similar open requests:* none found";

  const scopeLine = `*Scope:* ${s.size}. ${escapeSlackText(s.rationale)}`;

  const caveats = [a.repoConnected ? "sized from repo context" : "no repo connected, sized from description"];
  if (a.similar.items.length) {
    caveats.push(`${a.similar.items.length} similar request${a.similar.items.length === 1 ? "" : "s"}`);
  }

  const text = `Sized: ${s.restatement} (${s.size}, ${s.confidence} confidence)`;
  const blocks: SlackBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${escapeSlackText(s.restatement)}*` } },
    { type: "section", text: { type: "mrkdwn", text: `${requesterLine}\n${similarLine}\n${scopeLine}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `Confidence: ${s.confidence} · ${caveats.join(" · ")}` }] },
  ];
  return { text, blocks };
}

// Strip all <@U…> mentions (the bot's plus any others) and collapse whitespace.
function stripMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
