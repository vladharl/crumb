CREATE TABLE IF NOT EXISTS "customer_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"account_user_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"channel" varchar(16) DEFAULT 'email' NOT NULL,
	"to_status" varchar(16),
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_account_user_id_account_users_id_fk" FOREIGN KEY ("account_user_id") REFERENCES "public"."account_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_notifications_item_idx" ON "customer_notifications" USING btree ("item_id","sent_at");