CREATE TABLE IF NOT EXISTS "roadmap_follows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"initiative_id" uuid NOT NULL,
	"account_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roadmap_follows_initiative_id_account_user_id_unique" UNIQUE("initiative_id","account_user_id")
);
--> statement-breakpoint
ALTER TABLE "initiatives" ADD COLUMN "roadmap_column" varchar(8);--> statement-breakpoint
ALTER TABLE "initiatives" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "launcher_glass" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roadmap_follows" ADD CONSTRAINT "roadmap_follows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roadmap_follows" ADD CONSTRAINT "roadmap_follows_initiative_id_initiatives_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiatives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "roadmap_follows" ADD CONSTRAINT "roadmap_follows_account_user_id_account_users_id_fk" FOREIGN KEY ("account_user_id") REFERENCES "public"."account_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "roadmap_follows_initiative_idx" ON "roadmap_follows" USING btree ("initiative_id");