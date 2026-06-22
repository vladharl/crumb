CREATE TABLE IF NOT EXISTS "changelog_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"initiative_id" uuid,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"published_at" timestamp with time zone,
	"created_by_workspace_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" varchar(16) NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"token_expires_at" timestamp with time zone,
	"config" jsonb,
	"sync_cursor" text,
	"last_synced_at" timestamp with time zone,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_connections_ws_provider_uniq" UNIQUE("workspace_id","provider")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "item_tags" (
	"item_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"source" varchar(8) DEFAULT 'human' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_tags_item_id_tag_id_pk" PRIMARY KEY("item_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"color" varchar(16),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_ws_name_uniq" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
ALTER TABLE "inbound_captures" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "inbound_captures" ADD COLUMN "duplicate_of_item_id" uuid;--> statement-breakpoint
ALTER TABLE "inbound_captures" ADD COLUMN "duplicate_similarity" double precision;--> statement-breakpoint
ALTER TABLE "inbound_captures" ADD COLUMN "relevance_score" double precision;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "source" varchar(16);--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "source_url" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "changelog_entries" ADD CONSTRAINT "changelog_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "changelog_entries" ADD CONSTRAINT "changelog_entries_initiative_id_initiatives_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiatives"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "changelog_entries" ADD CONSTRAINT "changelog_entries_created_by_workspace_user_id_workspace_users_id_fk" FOREIGN KEY ("created_by_workspace_user_id") REFERENCES "public"."workspace_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "item_tags" ADD CONSTRAINT "item_tags_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "item_tags" ADD CONSTRAINT "item_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "changelog_entries_workspace_idx" ON "changelog_entries" USING btree ("workspace_id","published_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_connections_status_idx" ON "integration_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "item_tags_tag_idx" ON "item_tags" USING btree ("tag_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inbound_captures" ADD CONSTRAINT "inbound_captures_duplicate_of_item_id_items_id_fk" FOREIGN KEY ("duplicate_of_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "inbound_captures" ADD CONSTRAINT "inbound_captures_external_uniq" UNIQUE("workspace_id","source","external_id");