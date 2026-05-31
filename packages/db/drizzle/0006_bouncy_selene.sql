ALTER TABLE "replay_sessions" ADD COLUMN "screen_w" integer;--> statement-breakpoint
ALTER TABLE "replay_sessions" ADD COLUMN "screen_h" integer;--> statement-breakpoint
ALTER TABLE "replay_sessions" ADD COLUMN "caller_ip" text;--> statement-breakpoint
ALTER TABLE "replay_sessions" ADD COLUMN "geo_country" varchar(2);--> statement-breakpoint
ALTER TABLE "replay_sessions" ADD COLUMN "geo_city" text;--> statement-breakpoint
ALTER TABLE "replay_sessions" ADD COLUMN "device_type" varchar(16);--> statement-breakpoint
ALTER TABLE "replay_sessions" ADD COLUMN "browser_name" varchar(32);--> statement-breakpoint
ALTER TABLE "replay_sessions" ADD COLUMN "browser_version" varchar(32);--> statement-breakpoint
ALTER TABLE "replay_sessions" ADD COLUMN "os_name" varchar(32);--> statement-breakpoint
ALTER TABLE "replay_sessions" ADD COLUMN "os_version" varchar(32);