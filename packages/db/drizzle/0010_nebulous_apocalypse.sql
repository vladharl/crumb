ALTER TABLE "workspaces" ADD COLUMN "launcher_visibility" varchar(16) DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "launcher_offset_x" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "launcher_offset_y" integer DEFAULT 0 NOT NULL;