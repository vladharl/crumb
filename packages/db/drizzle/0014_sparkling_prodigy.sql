ALTER TABLE "items" ADD COLUMN "ai_summary" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "launcher_edge" varchar(8) DEFAULT 'right' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "position";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "launcher_glass";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "launcher_offset_x";