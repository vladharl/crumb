ALTER TABLE "workspaces" ALTER COLUMN "launcher_bg" SET DEFAULT '#1C1A17';--> statement-breakpoint
ALTER TABLE "initiatives" ADD COLUMN "roadmap_order" integer DEFAULT 0 NOT NULL;