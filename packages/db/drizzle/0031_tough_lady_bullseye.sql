CREATE TABLE IF NOT EXISTS "public_follows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"initiative_id" uuid,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_follows_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "public_pages_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public_follows" ADD CONSTRAINT "public_follows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public_follows" ADD CONSTRAINT "public_follows_initiative_id_initiatives_id_fk" FOREIGN KEY ("initiative_id") REFERENCES "public"."initiatives"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "public_follows_scope_email_uniq" ON "public_follows" USING btree ("workspace_id",coalesce("initiative_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("email"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "public_follows_initiative_idx" ON "public_follows" USING btree ("initiative_id");