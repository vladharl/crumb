ALTER TABLE "notification_preferences" ADD COLUMN "assigned_realtime" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "last_digest_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "inbound_message_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "replies_item_inbound_message_uniq" ON "replies" USING btree ("item_id","inbound_message_id");