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
} from "drizzle-orm/pg-core";

// ─── workspaces (vendor side) ────────────────────────────────
export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 64 }).notNull().unique(),
  name: text("name").notNull(),
  // Launcher circle background — the brown pill the dots sit inside.
  launcherBg: varchar("launcher_bg", { length: 16 }).notNull().default("#4A2E1F"),
  // The dot/mark color (the brand "loop" inside the launcher; also used
  // sparingly as a brand accent on the dashboard).
  accent: varchar("accent", { length: 16 }).notNull().default("#E27D3A"),
  position: varchar("position", { length: 16 }).notNull().default("corner"),
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
  since: timestamp("since", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byWs: index("accounts_workspace_idx").on(t.workspaceId),
}));

export const accountUsers = pgTable("account_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  name: text("name").notNull(),
  role: varchar("role", { length: 16 }).notNull().default("member"),
  initials: varchar("initials", { length: 4 }).notNull(),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqShort: unique().on(t.workspaceId, t.shortId),
  byWsStatus: index("items_workspace_status_idx").on(t.workspaceId, t.status),
  byAccount: index("items_account_idx").on(t.accountId),
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

export const __sql = sql; // re-export for convenience
