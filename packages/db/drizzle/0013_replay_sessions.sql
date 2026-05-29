-- Phase 10: Session Record (rrweb capture + replay).

-- Workspace-level opt-in. Widget reads this via /me and only injects
-- the recorder bundle when true. Cloud-gated at the product level but
-- the column exists everywhere for the toggle UI.
ALTER TABLE "workspaces" ADD COLUMN "session_record_enabled" boolean NOT NULL DEFAULT false;

-- One row per distinct customer session inside the widget.
CREATE TABLE "replay_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "account_user_id" uuid,
  "session_token" varchar(64) NOT NULL,
  "item_id" uuid,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ended_at" timestamp with time zone,
  "page_url" text,
  "user_agent" text,
  "viewport_w" integer,
  "viewport_h" integer,
  "event_count" integer NOT NULL DEFAULT 0,
  "size_bytes" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "replay_sessions" ADD CONSTRAINT "replay_sessions_workspace_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "replay_sessions" ADD CONSTRAINT "replay_sessions_account_user_fkey"
  FOREIGN KEY ("account_user_id") REFERENCES "account_users"("id") ON DELETE SET NULL;
ALTER TABLE "replay_sessions" ADD CONSTRAINT "replay_sessions_item_fkey"
  FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE;

ALTER TABLE "replay_sessions" ADD CONSTRAINT "replay_sessions_token_unique" UNIQUE ("session_token");
CREATE INDEX "replay_sessions_workspace_idx" ON "replay_sessions" ("workspace_id");
CREATE INDEX "replay_sessions_item_idx" ON "replay_sessions" ("item_id");

-- One row per uploaded chunk; bytes live in the storage provider.
CREATE TABLE "replay_chunks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "storage_key" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "event_count" integer NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "replay_chunks" ADD CONSTRAINT "replay_chunks_session_fkey"
  FOREIGN KEY ("session_id") REFERENCES "replay_sessions"("id") ON DELETE CASCADE;
ALTER TABLE "replay_chunks" ADD CONSTRAINT "replay_chunks_seq_unique" UNIQUE ("session_id", "sequence");
