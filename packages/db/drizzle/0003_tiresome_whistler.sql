CREATE TABLE IF NOT EXISTS "status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"from_status" varchar(16),
	"to_status" varchar(16) NOT NULL,
	"by_workspace_user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "status_events" ADD CONSTRAINT "status_events_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "status_events" ADD CONSTRAINT "status_events_by_workspace_user_id_workspace_users_id_fk" FOREIGN KEY ("by_workspace_user_id") REFERENCES "public"."workspace_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "status_events_item_idx" ON "status_events" USING btree ("item_id","at");