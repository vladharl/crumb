ALTER TABLE "account_users" ADD COLUMN "notify_replies" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "account_users" ADD COLUMN "notify_status" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "account_users" ADD COLUMN "notify_roadmap" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "account_users" ADD COLUMN "unsubscribed_all" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "account_users" ADD COLUMN "unsub_token" varchar(64) DEFAULT encode(gen_random_bytes(32), 'hex') NOT NULL;