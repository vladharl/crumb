CREATE TABLE IF NOT EXISTS "inbound_captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source" varchar(16) NOT NULL,
	"from_email" text,
	"from_name" text,
	"subject" text,
	"body" text DEFAULT '' NOT NULL,
	"suggested_account_id" uuid,
	"suggested_account_name" text,
	"suggested_confidence" double precision,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"created_item_id" uuid,
	"raw_meta" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_workspace_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "slack_webhook_url" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "teams_webhook_url" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "notify_chat_replies" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "notify_chat_status" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "notify_chat_roadmap" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "teams_webhook_url" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "teams_connected_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inbound_captures" ADD CONSTRAINT "inbound_captures_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inbound_captures" ADD CONSTRAINT "inbound_captures_suggested_account_id_accounts_id_fk" FOREIGN KEY ("suggested_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inbound_captures" ADD CONSTRAINT "inbound_captures_created_item_id_items_id_fk" FOREIGN KEY ("created_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inbound_captures" ADD CONSTRAINT "inbound_captures_decided_by_workspace_user_id_workspace_users_id_fk" FOREIGN KEY ("decided_by_workspace_user_id") REFERENCES "public"."workspace_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_captures_ws_status_idx" ON "inbound_captures" USING btree ("workspace_id","status","created_at");