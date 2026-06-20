import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  uuid,
  varchar,
  timestamp,
  integer,
  boolean,
  unique,
  index,
  doublePrecision,
  bigint,
  jsonb,
  primaryKey,
  customType,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ─── pgvector column type ────────────────────────────────────
// Drizzle 0.36's pg-core has no native vector type, so we declare one. The
// dimension is fixed at the column level (pgvector requires it) and MUST match
// the embedding model configured in lib/ai/embeddings.ts (AISTACK_EMBEDDINGS_MODEL).
// We pin 1024 and also store the model+dim per row (see itemEmbeddings) so a
// model swap is detectable and never silently mixes incompatible vector spaces.
// pgvector accepts/emits the literal "[a,b,c]" text form, which postgres.js
// passes through verbatim.
export const VECTOR_DIM = 1024;
const vector1024 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return `vector(${VECTOR_DIM})`;
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return JSON.parse(value) as number[];
  },
});

// ─── workspaces (vendor side) ────────────────────────────────
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  name: text("name").notNull(),
  // Launcher tab background — a warm ink the loop mark sits inside.
  launcherBg: varchar("launcher_bg", { length: 16 }).notNull().default("#1C1A17"),
  // Brand accent — used for the loop-news dot on the launcher and
  // sparingly as an accent on the dashboard.
  accent: varchar("accent", { length: 16 }).notNull().default("#E27D3A"),
  // Which viewport edge the whisper-tab launcher docks to.
  launcherEdge: varchar("launcher_edge", { length: 8 }).notNull().default("right"), // right | left
  // Whether crumb shows its own launcher tab. `hidden` lets a site that
  // already runs Intercom/Zendesk/etc. drive crumb via window.crumb.open()
  // from their existing chat widget — avoiding two competing widgets.
  launcherVisibility: varchar("launcher_visibility", { length: 16 }).notNull().default("auto"), // auto | always | hidden
  // Pixel nudge along the docked edge (positive = down from center), so the
  // tab can clear anything the host renders mid-edge.
  launcherOffsetY: integer("launcher_offset_y").notNull().default(0),
  nextItemSeq: integer("next_item_seq").notNull().default(1),
  // HS256 secret used to verify widget identity JWTs. 64 hex chars = 32 bytes.
  signingSecret: text("signing_secret").notNull().default(sql`encode(gen_random_bytes(32), 'hex')`),
  // Where the widget is embedded — used to build `?crumb_open=FB-N` deep
  // links in customer notification emails. Null means "no deep link;
  // tell customers to open Crumb inside <workspace> manually".
  productUrl: text("product_url"),
  // Per-workspace counter for initiative short IDs (IN-1, IN-2, …).
  // Mirrors the next_item_seq pattern.
  nextInitiativeSeq: integer("next_initiative_seq").notNull().default(1),

  // ── Slack install (workspace-level OAuth) ────────────────────
  // When non-null, the workspace has connected Slack and the bot token
  // can DM users back. bot_user_id is the Slack id of "Crumb" inside the
  // installed workspace, used to ensure we never reply to ourselves.
  slackTeamId:      text("slack_team_id"),
  slackTeamName:    text("slack_team_name"),
  slackBotToken:    text("slack_bot_token"),
  slackBotUserId:   text("slack_bot_user_id"),
  slackInstalledAt: timestamp("slack_installed_at", { withTimezone: true }),

  // ── Linear install (workspace-level OAuth) ───────────────────
  // Bearer token + the default team this workspace pushes new tickets to.
  linearAccessToken: text("linear_access_token"),
  linearTeamId:      text("linear_team_id"),
  linearTeamName:    text("linear_team_name"),
  linearInstalledAt: timestamp("linear_installed_at", { withTimezone: true }),

  // ── Jira install (Atlassian Cloud 3LO) ───────────────────────
  // cloud_id is discovered from /accessible-resources after token exchange
  // and re-checked on every refresh — it can drift if the user reinstalls
  // to a different site with the same refresh token.
  jiraAccessToken:        text("jira_access_token"),
  jiraRefreshToken:       text("jira_refresh_token"),
  jiraTokenExpiresAt:     timestamp("jira_token_expires_at", { withTimezone: true }),
  jiraCloudId:            text("jira_cloud_id"),
  jiraSiteUrl:            text("jira_site_url"),
  jiraDefaultProjectKey:  text("jira_default_project_key"),
  jiraInstalledAt:        timestamp("jira_installed_at", { withTimezone: true }),

  // ── GitHub App install ───────────────────────────────────────
  // No access_token here — installation tokens expire in 1h, we mint per
  // call from the App's JWT and cache in module memory.
  githubAppInstallId:      text("github_app_install_id"),
  githubAppInstallAccount: text("github_app_install_account"),
  githubDefaultRepo:       text("github_default_repo"),
  githubInstalledAt:       timestamp("github_installed_at", { withTimezone: true }),

  // ── HubSpot CRM install (OAuth) ──────────────────────────────
  // One-way sync of Companies → accounts + ARR. Tokens are sealed at rest
  // (lib/crypto-at-rest). portal_id identifies the connected HubSpot account.
  hubspotAccessToken:    text("hubspot_access_token"),
  hubspotRefreshToken:   text("hubspot_refresh_token"),
  hubspotTokenExpiresAt: timestamp("hubspot_token_expires_at", { withTimezone: true }),
  hubspotPortalId:       text("hubspot_portal_id"),
  hubspotInstalledAt:    timestamp("hubspot_installed_at", { withTimezone: true }),

  // ── Salesforce CRM install (OAuth web-server flow) ───────────
  // instance_url is returned with the token and scopes every REST/SOQL call
  // (orgs live on per-instance hosts). Refresh-token lifecycle mirrors Jira.
  salesforceAccessToken:    text("salesforce_access_token"),
  salesforceRefreshToken:   text("salesforce_refresh_token"),
  salesforceInstanceUrl:    text("salesforce_instance_url"),
  salesforceTokenExpiresAt: timestamp("salesforce_token_expires_at", { withTimezone: true }),
  salesforceInstalledAt:    timestamp("salesforce_installed_at", { withTimezone: true }),

  // ── MS Teams incoming webhook (vendor channel firehose; sealed) ──────
  // A Teams "Workflows"/incoming-webhook URL the workspace pastes; key events
  // (new submission, customer reply, status change) post an Adaptive Card here.
  // Not OAuth — a capability the vendor opts into by pasting a URL.
  teamsWebhookUrl:   text("teams_webhook_url"),
  teamsConnectedAt:  timestamp("teams_connected_at", { withTimezone: true }),

  // ── Session Record (Cloud only) ──────────────────────────────
  // Vendor-side opt-in. The widget receives this flag in /me's response
  // and only injects the rrweb recorder bundle when true.
  sessionRecordEnabled: boolean("session_record_enabled").notNull().default(false),

  // ── Stripe (Cloud only; self-host leaves these NULL) ─────────
  // The Stripe webhook handler keeps these in sync from Stripe's
  // subscription events; entitlement helpers in lib/tier read them. plan_id
  // is the canonical name we use internally ("free" | "team" | "growth");
  // mapping to a Stripe price ID lives in env config.
  stripeCustomerId:     text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  subscriptionStatus:   varchar("subscription_status", { length: 32 }),
    // null | trialing | active | past_due | canceled | incomplete | …
  currentPeriodEnd:     timestamp("current_period_end", { withTimezone: true }),
  seats:                integer("seats").notNull().default(1),
  planId:               varchar("plan_id", { length: 32 }).notNull().default("free"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceUsers = pgTable("workspace_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: varchar("role", { length: 16 }).notNull().default("pm"), // admin | pm | viewer
  initials: varchar("initials", { length: 4 }).notNull(),
  // Watermark used to compute the unread count on /notifications. NULL ⇒
  // never marked read, treat as epoch (everything is unread).
  notificationsLastReadAt: timestamp("notifications_last_read_at", { withTimezone: true }),
  // Watermark for the first-sign-in getting-started tour. NULL ⇒ the user has
  // never finished/skipped the walkthrough, so it auto-opens on next sign-in.
  // Stamped when they complete or dismiss it (and on manual relaunch).
  guideCompletedAt: timestamp("guide_completed_at", { withTimezone: true }),
  // Slack user_id resolved by email lookup against the workspace's Slack
  // install. Cached so we don't hit users.lookupByEmail on every send.
  // Failed lookups stamp slack_lookup_failed_at so we don't retry constantly.
  slackUserId:           text("slack_user_id"),
  slackLookupFailedAt:   timestamp("slack_lookup_failed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqEmail: unique().on(t.workspaceId, t.email),
}));

// Per-user notification preferences. One row per workspace_user (upsert on
// save). Delivery is "email" | "slack" | "none"; the Slack option is gated
// at the UI level on whether the workspace has the Slack app installed.
export const notificationPreferences = pgTable("notification_preferences", {
  workspaceUserId: uuid("workspace_user_id").primaryKey().references(() => workspaceUsers.id, { onDelete: "cascade" }),
  digestFrequency:           varchar("digest_frequency", { length: 16 }).notNull().default("daily"), // off | daily | weekly
  newSubmissionRealtime:     boolean("new_submission_realtime").notNull().default(true),
  replyRealtime:             boolean("reply_realtime").notNull().default(true),
  mentionRealtime:           boolean("mention_realtime").notNull().default(true),
  statusChangeRealtime:      boolean("status_change_realtime").notNull().default(false),
  clusterSuggestionsRealtime: boolean("cluster_suggestions_realtime").notNull().default(false),
  delivery:                  varchar("delivery", { length: 16 }).notNull().default("email"), // email | slack | none
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── accounts (customer side) ────────────────────────────────
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  arrCents: integer("arr_cents").notNull().default(0),
  // Where arrCents came from. "manual" (a PM typed it) is never overwritten by
  // a CRM sync unless the workspace opts into letting the CRM win; "crm" rows
  // are kept fresh on each sync. Surfaced in the UI as a "from HubSpot" badge.
  arrSource: varchar("arr_source", { length: 16 }).notNull().default("manual"), // manual | crm
  // CRM linkage (feature 1). Set when an account is matched to / created from a
  // CRM Company. external_crm_id is the provider's record id; the unique index
  // below makes sync upserts idempotent.
  externalCrmProvider: varchar("external_crm_provider", { length: 16 }), // hubspot | salesforce
  externalCrmId: text("external_crm_id"),
  crmSyncedAt: timestamp("crm_synced_at", { withTimezone: true }),
  // ── Customer-side chat webhooks (feature: dual-side notifications) ──
  // The customer's own Slack/Teams channel incoming-webhook URL (sealed at
  // rest). When set, vendor replies / status changes / roadmap updates also
  // post a card there, alongside the customer email. Notifications only — no
  // per-customer OAuth. Per-account toggles parallel accountUsers.notify*.
  slackWebhookUrl: text("slack_webhook_url"),
  teamsWebhookUrl: text("teams_webhook_url"),
  notifyChatReplies: boolean("notify_chat_replies").notNull().default(true),
  notifyChatStatus:  boolean("notify_chat_status").notNull().default(true),
  notifyChatRoadmap: boolean("notify_chat_roadmap").notNull().default(true),
  since: timestamp("since", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byWs: index("accounts_workspace_idx").on(t.workspaceId),
  // Idempotent CRM upsert key. NULLs are distinct in Postgres, so non-CRM
  // accounts (both columns NULL) never collide here.
  uniqCrm: unique("accounts_crm_uniq").on(t.workspaceId, t.externalCrmProvider, t.externalCrmId),
}));

export const accountUsers = pgTable("account_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: varchar("role", { length: 16 }).notNull().default("member"),
  initials: varchar("initials", { length: 4 }).notNull(),
  // Per-customer email notification prefs (the widget's Notifications view).
  // Each gates the matching customer-facing email; unsubscribedAll is the
  // master mute flipped by the one-click unsubscribe link.
  notifyReplies:   boolean("notify_replies").notNull().default(true),
  notifyStatus:    boolean("notify_status").notNull().default(true),
  notifyRoadmap:   boolean("notify_roadmap").notNull().default(true),
  unsubscribedAll: boolean("unsubscribed_all").notNull().default(false),
  // Capability token embedded in the unsubscribe link (no login needed).
  unsubToken: varchar("unsub_token", { length: 64 }).notNull().default(sql`encode(gen_random_bytes(32), 'hex')`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqEmail: unique().on(t.workspaceId, t.email),
}));

// ─── items (feedback) ────────────────────────────────────────
export const items = pgTable("items", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  submitterId: uuid("submitter_id").notNull().references(() => accountUsers.id, { onDelete: "restrict" }),
  assigneeId: uuid("assignee_id").references(() => workspaceUsers.id, { onDelete: "set null" }),
  initiativeId: uuid("initiative_id").references(() => initiatives.id, { onDelete: "set null" }),
  seq: integer("seq").notNull(),
  shortId: varchar("short_id", { length: 32 }).notNull(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  type: varchar("type", { length: 16 }).notNull(), // bug | idea | question | integration
  status: varchar("status", { length: 16 }).notNull().default("open"),
  // Generic external-ticket link. One item → at most one external ticket.
  // external_provider tells us which API to call for re-sync.
  externalProvider:   varchar("external_provider", { length: 16 }), // linear | jira | github
  externalTicketId:   text("external_ticket_id"),
  externalTicketUrl:  text("external_ticket_url"),
  externalStatus:     text("external_status"),
  externalSyncedAt:   timestamp("external_synced_at", { withTimezone: true }),

  // ── AI auto-triage (feature 3; Cloud-only writes) ────────────
  // Advisory attributes the triage model fills in fire-and-forget at capture.
  // These are SUGGESTIONS shown as badges/chips — they never overwrite the
  // human-owned `type`/`assignee_id`/`status` (a misclassification must not
  // silently re-route). ai_sentiment is -1..1, ai_urgency 0..1.
  aiType:               varchar("ai_type", { length: 16 }),     // bug | idea | question | integration
  aiSeverity:           varchar("ai_severity", { length: 16 }), // low | medium | high | critical
  aiSentiment:          doublePrecision("ai_sentiment"),
  aiUrgency:            doublePrecision("ai_urgency"),
  aiSuggestedAssigneeId: uuid("ai_suggested_assignee_id").references(() => workspaceUsers.id, { onDelete: "set null" }),
  aiTriageReason:       text("ai_triage_reason"),
  // One-line vendor-facing summary for inbox scanning. Written by the same
  // triage call; null on self-host (the inbox falls back to a body snippet).
  aiSummary:            text("ai_summary"),
  aiTriagedAt:          timestamp("ai_triaged_at", { withTimezone: true }),
  aiTriageModel:        varchar("ai_triage_model", { length: 64 }),

  // ── Duplicate merge (feature 4) ──────────────────────────────
  // When set, this item is a duplicate folded into merged_into_id (the
  // canonical item). status is flipped to "duplicate" in the same write.
  // Effective ARR/followers for a canonical item are computed over the group
  // {canonical} ∪ {items where merged_into_id = canonical}. Self-FK ⇒ needs
  // the AnyPgColumn return annotation.
  mergedIntoId:           uuid("merged_into_id").references((): AnyPgColumn => items.id, { onDelete: "set null" }),
  mergedAt:               timestamp("merged_at", { withTimezone: true }),
  mergedByWorkspaceUserId: uuid("merged_by_workspace_user_id").references(() => workspaceUsers.id, { onDelete: "set null" }),

  // ── Translation (feature 7; Cloud-only writes) ───────────────
  // detected_lang is a BCP-47-ish code from language detection at capture.
  // When it differs from the workspace language we store a translation so the
  // vendor reads the feedback in their own language without a round-trip.
  detectedLang:    varchar("detected_lang", { length: 8 }),
  titleTranslated: text("title_translated"),
  bodyTranslated:  text("body_translated"),
  translatedAt:    timestamp("translated_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqShort: unique().on(t.workspaceId, t.shortId),
  byWsStatus: index("items_workspace_status_idx").on(t.workspaceId, t.status),
  byAccount: index("items_account_idx").on(t.accountId),
  byMergedInto: index("items_merged_into_idx").on(t.mergedIntoId),
}));

// ─── replies ─────────────────────────────────────────────────
export const replies = pgTable("replies", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  workspaceUserId: uuid("workspace_user_id").references(() => workspaceUsers.id, { onDelete: "set null" }),
  accountUserId: uuid("account_user_id").references(() => accountUsers.id, { onDelete: "set null" }),
  body: text("body").notNull(),
  internal: boolean("internal").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byItem: index("replies_item_idx").on(t.itemId, t.createdAt),
}));

// @-mentions on an internal note: one row per (reply, mentioned teammate).
// Written when an internal reply is saved (parsed from the body against the
// workspace's members). Powers the mention notification + the Notifications
// "Mentions" filter. Customer-facing replies don't carry mentions.
export const replyMentions = pgTable("reply_mentions", {
  id: uuid("id").primaryKey().defaultRandom(),
  replyId: uuid("reply_id").notNull().references(() => replies.id, { onDelete: "cascade" }),
  workspaceUserId: uuid("workspace_user_id").notNull().references(() => workspaceUsers.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniq: unique().on(t.replyId, t.workspaceUserId),
  byUser: index("reply_mentions_user_idx").on(t.workspaceUserId),
}));
export type ReplyMention = typeof replyMentions.$inferSelect;

// ─── status events (audit trail for status transitions) ─────
export const statusEvents = pgTable("status_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  fromStatus: varchar("from_status", { length: 16 }),     // null on initial creation
  toStatus: varchar("to_status", { length: 16 }).notNull(),
  // Optional explanation captured for "won't ship" / "set aside" / "duplicate".
  reason: text("reason"),
  byWorkspaceUserId: uuid("by_workspace_user_id").references(() => workspaceUsers.id, { onDelete: "set null" }),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byItem: index("status_events_item_idx").on(t.itemId, t.at),
}));

// ─── customer notifications (the loop-close ledger) ──────────
// One row per notification actually delivered to a customer about their item —
// a vendor reply or a status change. This is what makes "the loop closed when
// the customer heard the outcome" measurable (Insights loop time) instead of
// inferred from internal status alone. Written best-effort after the provider
// accepts the send; never blocks the action that triggered it.
export const customerNotifications = pgTable("customer_notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  accountUserId: uuid("account_user_id").notNull().references(() => accountUsers.id, { onDelete: "cascade" }),
  // What the customer was told: 'reply' (vendor answered) or 'status' (state moved).
  kind: varchar("kind", { length: 16 }).notNull(),
  // Delivery channel — 'email' today; account Slack/Teams channels later.
  channel: varchar("channel", { length: 16 }).notNull().default("email"),
  // For kind='status': the status the customer was told about. Lets the loop-time
  // query find "informed of shipped/declined" without re-joining status_events.
  toStatus: varchar("to_status", { length: 16 }),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byItem: index("customer_notifications_item_idx").on(t.itemId, t.sentAt),
}));

// ─── initiatives (vendor-only grouping for items) ────────────
// Manual buckets the vendor uses to roll up themed asks ("User Management",
// "Reporting"). Items belong to 0 or 1 initiative. Vendor-internal — not
// surfaced through the widget. The AI clustering phase later will suggest
// initiative membership for new items.
export const initiatives = pgTable("initiatives", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  shortId: varchar("short_id", { length: 16 }).notNull(),
  name: text("name").notNull(),
  description: text("description"),
  status: varchar("status", { length: 16 }).notNull().default("open"), // open | in_progress | shipped | parked
  color: varchar("color", { length: 16 }),
  // Public roadmap placement. null = not on the public roadmap; otherwise the
  // Now/Next/Later column. is_public gates customer visibility in the widget.
  roadmapColumn: varchar("roadmap_column", { length: 8 }), // null | now | next | later
  // Manual sort position within a board column (lower = higher up). Set by
  // drag-to-reorder on the Initiatives board.
  roadmapOrder: integer("roadmap_order").notNull().default(0),
  isPublic: boolean("is_public").notNull().default(false),
  // Usage-event names whose adoption this initiative drives. When set and the
  // initiative ships, the detail page measures pre/post adoption of these
  // events (usage analytics). null = no impact tracking.
  trackedEventNames: text("tracked_event_names").array(),
  ownerWorkspaceUserId: uuid("owner_workspace_user_id").references(() => workspaceUsers.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqShort: unique().on(t.workspaceId, t.shortId),
  byWs: index("initiatives_workspace_idx").on(t.workspaceId),
}));

// ─── initiative suggestions (AI clustering) ──────────────────
// One row per AI-generated guess "item X belongs to initiative Y". Lives
// alongside items rather than replacing item.initiative_id — the vendor
// still owns the final say. UI shows pending suggestions inline; accept
// writes the FK on items and flips status to "accepted"; dismiss leaves
// the FK alone and flips to "dismissed". We keep a history per item so a
// later model rerun can supersede an earlier dismissal.
//
// Cloud-only feature; self-host never writes rows here. Confidence is the
// model's self-rated 0-1 score; reason is a one-line rationale shown on
// hover to build trust.
export const initiativeSuggestions = pgTable("initiative_suggestions", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  initiativeId: uuid("initiative_id").notNull().references(() => initiatives.id, { onDelete: "cascade" }),
  confidence: doublePrecision("confidence").notNull(),
  reason: text("reason"),
  status: varchar("status", { length: 16 }).notNull().default("pending"), // pending | accepted | dismissed
  model: varchar("model", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (t) => ({
  byItemStatus: index("init_sugg_item_status_idx").on(t.itemId, t.status),
  byInitiativeStatus: index("init_sugg_initiative_status_idx").on(t.initiativeId, t.status),
}));

// ─── ticket suggestions (AI-drafted external tickets) ───────
// One row per AI draft for an external ticket (Linear / Jira / GitHub).
// Persisted so vendors can compare draft vs. accepted, and so a later
// model rerun can supersede an earlier dismissal. Cloud-only writes.
//
// provider_target snapshots which team / project / repo the draft was
// aimed at — if the workspace default changes between draft and accept,
// we still create the ticket where the AI thought it would land.
export const ticketSuggestions = pgTable("ticket_suggestions", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 16 }).notNull(), // linear | jira | github
  draftTitle: text("draft_title").notNull(),
  draftBody: text("draft_body").notNull().default(""),
  draftLabels: text("draft_labels").array(),
  providerTarget: text("provider_target"),
  confidence: doublePrecision("confidence").notNull(),
  reason: text("reason"),
  status: varchar("status", { length: 16 }).notNull().default("pending"), // pending | accepted | dismissed
  model: varchar("model", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (t) => ({
  byItemStatus: index("ticket_sugg_item_status_idx").on(t.itemId, t.status),
}));

// ─── item embeddings (pgvector; semantic dedup + search) ─────
// One row per item, kept in a side table so the heavy vector column never
// bloats item row scans. Written fire-and-forget at capture (and on edit)
// by the Cloud-only embeddings path; self-host leaves this empty.
//
// The HNSW cosine index is created by raw SQL in the migration (drizzle-kit
// can't express it). model+dim are stored per row so a model change is
// detectable — a re-embed job re-generates rows where model != the configured
// model. content_hash (sha256 of title+body) lets us skip re-embedding when
// the text is unchanged.
export const itemEmbeddings = pgTable("item_embeddings", {
  itemId: uuid("item_id").primaryKey().references(() => items.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  embedding: vector1024("embedding").notNull(),
  model: varchar("model", { length: 64 }).notNull(),
  dim: integer("dim").notNull().default(VECTOR_DIM),
  contentHash: varchar("content_hash", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byWorkspace: index("item_embeddings_ws_idx").on(t.workspaceId),
}));

// ─── dedupe suggestions (AI duplicate detection; feature 4) ──
// One row per "item_id looks like a duplicate of candidate_item_id", produced
// from pgvector similarity at capture. Mirrors the initiative/ticket suggestion
// lifecycle (pending → accepted/dismissed). Accept performs the smart merge
// (item_id is folded into candidate_item_id). Cloud-only writes (needs
// embeddings); on self-host nothing populates it.
export const dedupeSuggestions = pgTable("dedupe_suggestions", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => items.id, { onDelete: "cascade" }), // the likely duplicate
  candidateItemId: uuid("candidate_item_id").notNull().references(() => items.id, { onDelete: "cascade" }), // the canonical match
  similarity: doublePrecision("similarity").notNull(),
  status: varchar("status", { length: 16 }).notNull().default("pending"), // pending | accepted | dismissed
  model: varchar("model", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (t) => ({
  byItemStatus: index("dedupe_sugg_item_status_idx").on(t.itemId, t.status),
}));

export type DedupeSuggestion = typeof dedupeSuggestions.$inferSelect;
export type NewDedupeSuggestion = typeof dedupeSuggestions.$inferInsert;

// ─── inbound captures (meet-customers-where-they-are; pending triage) ──
// A piece of feedback arriving from an external channel (a forwarded email, a
// Slack message, a browser/email extension) that hasn't been mapped to a
// customer yet. It lands here PENDING — items.account_id/submitter_id are NOT
// NULL, so a capture can't be an item until a vendor confirms the account
// (accept routes through composeItem, which upserts account+submitter). An AI
// account suggester (Cloud-only) pre-fills suggested_account_id; self-host
// leaves it null for manual mapping.
export const inboundCaptures = pgTable("inbound_captures", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  source: varchar("source", { length: 16 }).notNull(), // email | slack | extension
  fromEmail: text("from_email"),
  fromName: text("from_name"),
  subject: text("subject"),
  body: text("body").notNull().default(""),
  suggestedAccountId: uuid("suggested_account_id").references(() => accounts.id, { onDelete: "set null" }),
  suggestedAccountName: text("suggested_account_name"),
  suggestedConfidence: doublePrecision("suggested_confidence"),
  status: varchar("status", { length: 16 }).notNull().default("pending"), // pending | accepted | dismissed
  createdItemId: uuid("created_item_id").references(() => items.id, { onDelete: "set null" }),
  rawMeta: text("raw_meta"), // JSON string of the provider payload (message_id, etc.)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedByWorkspaceUserId: uuid("decided_by_workspace_user_id").references(() => workspaceUsers.id, { onDelete: "set null" }),
}, (t) => ({
  byWsStatus: index("inbound_captures_ws_status_idx").on(t.workspaceId, t.status, t.createdAt),
}));

export type InboundCapture = typeof inboundCaptures.$inferSelect;
export type NewInboundCapture = typeof inboundCaptures.$inferInsert;

// ─── replay sessions (rrweb session record) ──────────────────
// One row per distinct customer session inside the widget. Created the
// first time the recorder flushes a chunk; linked to a feedback item
// only if the customer submits one before the session ends.
//
// Hard caps prevent storage blow-up: max 10 MB / 5000 events / 30 min.
// Enforced both client-side (recorder stops itself) and server-side (the
// ingest endpoint returns 413).
//
// Cloud-only at the product level; the table exists on self-host but
// nothing writes to it unless the storage provider + tier are configured.
export const replaySessions = pgTable("replay_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  // Optional — anonymous visitors don't have an accountUser yet at session start.
  accountUserId: uuid("account_user_id").references(() => accountUsers.id, { onDelete: "set null" }),
  // High-entropy random; the widget keeps this in sessionStorage so reloads
  // continue the same session. Used to look up the row at chunk time.
  sessionToken: varchar("session_token", { length: 64 }).notNull().unique(),
  // Set on item submit if the widget POSTed a session_token. ON DELETE
  // CASCADE so removing an item also drops its replay.
  itemId: uuid("item_id").references(() => items.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  pageUrl: text("page_url"),
  userAgent: text("user_agent"),
  viewportW: integer("viewport_w"),
  viewportH: integer("viewport_h"),
  // Physical screen size (vs. the layout viewport above) — helps tell a
  // zoomed/small-window session from a genuinely small device.
  screenW: integer("screen_w"),
  screenH: integer("screen_h"),
  // Session context, derived server-side on the first chunk. callerIp comes
  // from the request (x-forwarded-for); geo is read from proxy headers when
  // present (Cloudflare / Vercel) — null when none. device/browser/os are
  // parsed from userAgent (lib/replay/ua.ts).
  callerIp: text("caller_ip"),
  geoCountry: varchar("geo_country", { length: 2 }),
  geoCity: text("geo_city"),
  deviceType: varchar("device_type", { length: 16 }),
  browserName: varchar("browser_name", { length: 32 }),
  browserVersion: varchar("browser_version", { length: 32 }),
  osName: varchar("os_name", { length: 32 }),
  osVersion: varchar("os_version", { length: 32 }),
  // Running totals — updated on each chunk insert. The server enforces
  // the caps against these.
  eventCount: integer("event_count").notNull().default(0),
  sizeBytes: integer("size_bytes").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byWorkspace: index("replay_sessions_workspace_idx").on(t.workspaceId),
  byItem: index("replay_sessions_item_idx").on(t.itemId),
}));

// One row per uploaded chunk. The bytes themselves live in the storage
// provider (local disk / future S3); storage_key is the opaque pointer.
export const replayChunks = pgTable("replay_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => replaySessions.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  storageKey: text("storage_key").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  eventCount: integer("event_count").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqSeq: unique().on(t.sessionId, t.sequence),
}));

// ─── replay summaries (AI; feature 8) ────────────────────────
// One row per session that's been summarized on-demand. highlights are short
// human-readable beats ("hunted for Export for 40s"); summary is a paragraph.
// Cloud-only writes; requires session_record + ai.
export const replaySummaries = pgTable("replay_summaries", {
  sessionId: uuid("session_id").primaryKey().references(() => replaySessions.id, { onDelete: "cascade" }),
  summary: text("summary").notNull(),
  highlights: text("highlights").array(),
  model: varchar("model", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── usage events (product analytics) ────────────────────────
// One row per `crumb.track(name, props)` call from the widget. Powers the
// usage signals on accounts, the churn "went inactive" signal, the thread
// breadcrumb, initiative adoption, and the AI usage-query interface.
//
// This is the one genuinely high-cardinality table — a monthly count cap
// (lib/usage.ts) and a retention sweep keep it bounded. accountId/accountUserId
// resolve from the widget's identity (JWT or trusted email), like items.
export const usageEvents = pgTable("usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  // Nullable until identity resolves; in practice always set on Cloud (JWT
  // required). ON DELETE CASCADE so removing an account drops its events.
  accountId: uuid("account_id").references(() => accounts.id, { onDelete: "cascade" }),
  accountUserId: uuid("account_user_id").references(() => accountUsers.id, { onDelete: "set null" }),
  name: varchar("name", { length: 64 }).notNull(),
  props: jsonb("props").notNull().default({}),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  // Ties to replay_sessions.session_token when a recording was active — no FK
  // (replay is Cloud+plan-gated and often off).
  sessionToken: varchar("session_token", { length: 64 }),
  pageUrl: text("page_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byWorkspaceTs: index("usage_events_workspace_ts_idx").on(t.workspaceId, t.ts),
  byAccountTs: index("usage_events_account_ts_idx").on(t.accountId, t.ts),
  byWorkspaceNameTs: index("usage_events_workspace_name_ts_idx").on(t.workspaceId, t.name, t.ts),
  // eventsBefore() (thread usage breadcrumb) filters by account_user_id and
  // orders by ts desc; without this it seq-scans the whole events table on
  // every thread open. (account_user_id, ts) makes it a bounded backward scan.
  byAccountUserTs: index("usage_events_account_user_ts_idx").on(t.accountUserId, t.ts),
}));

// ─── auth: magic tokens (single-use) ─────────────────────────
export const magicTokens = pgTable("magic_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  workspaceUserId: uuid("workspace_user_id").notNull().references(() => workspaceUsers.id, { onDelete: "cascade" }),
  token: varchar("token", { length: 64 }).notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── auth: sessions (renewable, cookie-bound) ────────────────
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  workspaceUserId: uuid("workspace_user_id").notNull().references(() => workspaceUsers.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUser: index("sessions_user_idx").on(t.workspaceUserId, t.expiresAt),
}));

// ─── relations (for joins) ───────────────────────────────────
export const itemsRelations = relations(items, ({ one, many }) => ({
  account: one(accounts, { fields: [items.accountId], references: [accounts.id] }),
  submitter: one(accountUsers, { fields: [items.submitterId], references: [accountUsers.id] }),
  assignee: one(workspaceUsers, { fields: [items.assigneeId], references: [workspaceUsers.id] }),
  initiative: one(initiatives, { fields: [items.initiativeId], references: [initiatives.id] }),
  replies: many(replies),
}));

export const initiativesRelations = relations(initiatives, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [initiatives.workspaceId], references: [workspaces.id] }),
  owner: one(workspaceUsers, { fields: [initiatives.ownerWorkspaceUserId], references: [workspaceUsers.id] }),
  items: many(items),
}));

export const repliesRelations = relations(replies, ({ one }) => ({
  item: one(items, { fields: [replies.itemId], references: [items.id] }),
  workspaceUser: one(workspaceUsers, { fields: [replies.workspaceUserId], references: [workspaceUsers.id] }),
  accountUser: one(accountUsers, { fields: [replies.accountUserId], references: [accountUsers.id] }),
}));

export const accountsRelations = relations(accounts, ({ many }) => ({
  items: many(items),
  users: many(accountUsers),
}));

export const accountUsersRelations = relations(accountUsers, ({ one }) => ({
  account: one(accounts, { fields: [accountUsers.accountId], references: [accounts.id] }),
}));

// Attachments — one row per uploaded file. v1 only attaches to replies;
// the customer's initial submission lives in items.body without files.
//
// reply_id is nullable to allow a two-phase upload flow: the client uploads
// the file first (creates a row with reply_id=NULL), then submits the
// reply along with the attachment id, which the reply handler links by
// setting reply_id. Orphans (uploaded but never linked) are tolerated in
// v1; a periodic cleanup of unlinked rows older than 1h is a follow-up.
//
// Uploader is exactly one of workspace_user_id (vendor) or account_user_id
// (customer); never both. The storage key is opaque to the schema —
// resolved by the storage provider at download time.
export const attachments = pgTable("attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  replyId: uuid("reply_id").references(() => replies.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  contentType: varchar("content_type", { length: 128 }).notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  storageKey: text("storage_key").notNull(),
  uploadedByWorkspaceUserId: uuid("uploaded_by_workspace_user_id").references(() => workspaceUsers.id, { onDelete: "set null" }),
  uploadedByAccountUserId: uuid("uploaded_by_account_user_id").references(() => accountUsers.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Reply = typeof replies.$inferSelect;
export type Attachment = typeof attachments.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type AccountUser = typeof accountUsers.$inferSelect;
export type WorkspaceUser = typeof workspaceUsers.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type NotificationPreferences = typeof notificationPreferences.$inferSelect;
export type Initiative = typeof initiatives.$inferSelect;
export type NewInitiative = typeof initiatives.$inferInsert;
export type InitiativeSuggestion = typeof initiativeSuggestions.$inferSelect;
export type NewInitiativeSuggestion = typeof initiativeSuggestions.$inferInsert;
export type TicketSuggestion = typeof ticketSuggestions.$inferSelect;
export type NewTicketSuggestion = typeof ticketSuggestions.$inferInsert;
export type ReplaySession = typeof replaySessions.$inferSelect;
export type NewReplaySession = typeof replaySessions.$inferInsert;
export type ReplayChunk = typeof replayChunks.$inferSelect;
export type NewReplayChunk = typeof replayChunks.$inferInsert;

// ─── storage blobs (Postgres-backed blob store) ──────────────
// Interim object store for Cloud: attachments + replay chunks can be kept
// in Postgres so multiple app instances share storage without a filesystem
// or S3 (selected via CRUMB_STORAGE_PROVIDER=postgres). Bytes are stored
// base64-encoded in a text column — keeps us off postgres.js bytea encoding
// quirks; the ~33% overhead is acceptable until a real S3/R2 adapter lands.
// `key` is the opaque storage key the local provider also uses verbatim.
export const storageBlobs = pgTable("storage_blobs", {
  key: text("key").primaryKey(),
  contentType: text("content_type").notNull(),
  dataB64: text("data_b64").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type StorageBlob = typeof storageBlobs.$inferSelect;
export type NewStorageBlob = typeof storageBlobs.$inferInsert;

// ─── usage counters (per-workspace cost metering) ────────────
// One row per (workspace, metric, period). `period` is a UTC month key
// ("YYYY-MM") so caps reset monthly without a cron. `count` is a running
// total bumped via upsert at the metered boundary:
//   - metric "ai"          → +1 per LLM inference (clustering + ticket drafts)
//   - metric "replay_bytes"→ +N bytes per ingested replay chunk
// Caps live in lib/entitlements + lib/usage; this table is just the meter.
// Cloud-only in practice (the metered features are Cloud-gated), but the
// table exists everywhere — self-host simply never checks a cap.
export const usageCounters = pgTable("usage_counters", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  metric: varchar("metric", { length: 32 }).notNull(),
  period: varchar("period", { length: 7 }).notNull(), // "YYYY-MM" (UTC)
  // bigint for replay_bytes (can exceed 2^31 in a busy month); mode "number"
  // keeps the JS surface a plain number (safe < 2^53 ≈ 9 PB).
  count: bigint("count", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.workspaceId, t.metric, t.period] }),
}));

export type UsageCounter = typeof usageCounters.$inferSelect;

// ─── webhook endpoints (outbound event subscriptions) ────────
// Vendors register HTTPS endpoints to receive signed events when an item's
// status changes (more event types can be added to `events` later). Each
// endpoint has its own HMAC secret used to sign the payload
// (X-Crumb-Signature: sha256=…). Delivery is best-effort with a short
// in-process retry; `failure_count` / `last_status` surface health in the UI
// and auto-pause a chronically failing endpoint.
export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  // Per-endpoint signing secret (hex). Generated on create.
  secret: text("secret").notNull(),
  // Event types this endpoint receives. v1 emits "item.status_changed".
  events: text("events").array().notNull().default(sql`'{"item.status_changed"}'`),
  active: boolean("active").notNull().default(true),
  lastStatus: integer("last_status"),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  failureCount: integer("failure_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byWorkspace: index("webhook_endpoints_workspace_idx").on(t.workspaceId),
}));

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;

// ─── API keys (workspace-scoped bearer tokens for MCP / API access) ──
// A vendor mints a key from settings and hands it to an external client (an
// MCP host like Claude/Cursor, or a script). We store only the sha256 hash of
// the raw key — the same one-way scheme as `sessions.token_hash` — so a DB read
// can't recover a usable token. `prefix` is the first few visible chars, kept
// for display ("crumb_sk_a1b2…") so a vendor can recognize a key in the list.
//
// Every key is tied to its creator (`created_by_workspace_user_id`): there is
// no system/bot workspace user, and `status_events.by_workspace_user_id` /
// `replies.workspace_user_id` are NOT NULL, so a write made through a key is
// attributed to the person who minted it. Cascade-deleting the creator (e.g.
// removing a teammate) therefore revokes their keys.
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  // The actor for any write performed with this key.
  createdByWorkspaceUserId: uuid("created_by_workspace_user_id").notNull().references(() => workspaceUsers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),                         // human label
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(), // sha256 hex of the raw key
  prefix: varchar("prefix", { length: 24 }).notNull(),  // first visible chars, for display
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  // Soft-revoke (keeps the row for the audit/list). A revoked key fails resolution.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byWorkspace: index("api_keys_workspace_idx").on(t.workspaceId),
}));

export type ApiKey = typeof apiKeys.$inferSelect;

// ─── roadmap follows (customer subscribes to a public initiative) ────
// One row per (account_user, initiative). When a vendor moves a followed
// initiative's roadmap column or status, followers get a notification email.
export const roadmapFollows = pgTable("roadmap_follows", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  initiativeId: uuid("initiative_id").notNull().references(() => initiatives.id, { onDelete: "cascade" }),
  accountUserId: uuid("account_user_id").notNull().references(() => accountUsers.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniq: unique().on(t.initiativeId, t.accountUserId),
  byInitiative: index("roadmap_follows_initiative_idx").on(t.initiativeId),
}));

export type RoadmapFollow = typeof roadmapFollows.$inferSelect;

// ─── feedback answers ("Ask your feedback"; feature 5) ───────
// History of natural-language Q&A over the corpus, with the item ids the
// answer cited. Kept so QBR exports can reuse a saved answer and so we can
// show recent questions. Cloud-only writes.
export const feedbackAnswers = pgTable("feedback_answers", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  citedItemIds: uuid("cited_item_ids").array(),
  model: varchar("model", { length: 64 }),
  askedByWorkspaceUserId: uuid("asked_by_workspace_user_id").references(() => workspaceUsers.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byWorkspace: index("feedback_answers_workspace_idx").on(t.workspaceId, t.createdAt),
}));

export type ItemEmbedding = typeof itemEmbeddings.$inferSelect;
export type NewItemEmbedding = typeof itemEmbeddings.$inferInsert;
export type ReplaySummary = typeof replaySummaries.$inferSelect;
export type NewReplaySummary = typeof replaySummaries.$inferInsert;
export type FeedbackAnswer = typeof feedbackAnswers.$inferSelect;
export type NewFeedbackAnswer = typeof feedbackAnswers.$inferInsert;

export const __sql = sql; // re-export for convenience
