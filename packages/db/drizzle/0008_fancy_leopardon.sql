CREATE TABLE IF NOT EXISTS "dedupe_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"candidate_item_id" uuid NOT NULL,
	"similarity" double precision NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"model" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dedupe_suggestions" ADD CONSTRAINT "dedupe_suggestions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dedupe_suggestions" ADD CONSTRAINT "dedupe_suggestions_candidate_item_id_items_id_fk" FOREIGN KEY ("candidate_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dedupe_sugg_item_status_idx" ON "dedupe_suggestions" USING btree ("item_id","status");