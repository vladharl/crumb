CREATE TABLE IF NOT EXISTS "inbox_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"query" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_views_user_name_uniq" UNIQUE("workspace_user_id","name")
);
--> statement-breakpoint
ALTER TABLE "account_users" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "external_ticket_uid" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inbox_views" ADD CONSTRAINT "inbox_views_workspace_user_id_workspace_users_id_fk" FOREIGN KEY ("workspace_user_id") REFERENCES "public"."workspace_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "items_external_ticket_uid_idx" ON "items" USING btree ("workspace_id","external_provider","external_ticket_uid");