-- pgvector: required by item_embeddings.embedding (vector(1024)). drizzle-kit
-- does not emit extension statements, so this is hand-added (same as the
-- pgcrypto line in 0000_baseline). Needs the pgvector/pgvector image or an
-- external Postgres with the extension available.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedback_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"cited_item_ids" uuid[],
	"model" varchar(64),
	"asked_by_workspace_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "item_embeddings" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"model" varchar(64) NOT NULL,
	"dim" integer DEFAULT 1024 NOT NULL,
	"content_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "replay_summaries" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"summary" text NOT NULL,
	"highlights" text[],
	"model" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "arr_source" varchar(16) DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "external_crm_provider" varchar(16);--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "external_crm_id" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "crm_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "ai_type" varchar(16);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "ai_severity" varchar(16);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "ai_sentiment" double precision;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "ai_urgency" double precision;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "ai_suggested_assignee_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "ai_triage_reason" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "ai_triaged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "ai_triage_model" varchar(64);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "merged_by_workspace_user_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "detected_lang" varchar(8);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "title_translated" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "body_translated" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "translated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "hubspot_access_token" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "hubspot_refresh_token" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "hubspot_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "hubspot_portal_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "hubspot_installed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "salesforce_access_token" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "salesforce_refresh_token" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "salesforce_instance_url" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "salesforce_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "salesforce_installed_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feedback_answers" ADD CONSTRAINT "feedback_answers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "feedback_answers" ADD CONSTRAINT "feedback_answers_asked_by_workspace_user_id_workspace_users_id_fk" FOREIGN KEY ("asked_by_workspace_user_id") REFERENCES "public"."workspace_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "item_embeddings" ADD CONSTRAINT "item_embeddings_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "item_embeddings" ADD CONSTRAINT "item_embeddings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "replay_summaries" ADD CONSTRAINT "replay_summaries_session_id_replay_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."replay_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feedback_answers_workspace_idx" ON "feedback_answers" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "item_embeddings_ws_idx" ON "item_embeddings" USING btree ("workspace_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_ai_suggested_assignee_id_workspace_users_id_fk" FOREIGN KEY ("ai_suggested_assignee_id") REFERENCES "public"."workspace_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_merged_into_id_items_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "items" ADD CONSTRAINT "items_merged_by_workspace_user_id_workspace_users_id_fk" FOREIGN KEY ("merged_by_workspace_user_id") REFERENCES "public"."workspace_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_merged_into_idx" ON "items" USING btree ("merged_into_id");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_crm_uniq" UNIQUE("workspace_id","external_crm_provider","external_crm_id");--> statement-breakpoint
-- HNSW cosine index for semantic dedup (#4) + Ask-your-feedback retrieval (#5).
-- Hand-added: drizzle-kit can't express USING hnsw. vector_cosine_ops matches
-- the `1 - (embedding <=> query)` cosine-similarity queries in lib/ai/dedup.ts.
CREATE INDEX IF NOT EXISTS "item_embeddings_hnsw" ON "item_embeddings" USING hnsw ("embedding" vector_cosine_ops);