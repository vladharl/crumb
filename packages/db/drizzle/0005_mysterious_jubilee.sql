CREATE TABLE IF NOT EXISTS "reply_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reply_id" uuid NOT NULL,
	"workspace_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_mentions_reply_id_workspace_user_id_unique" UNIQUE("reply_id","workspace_user_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reply_mentions" ADD CONSTRAINT "reply_mentions_reply_id_replies_id_fk" FOREIGN KEY ("reply_id") REFERENCES "public"."replies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reply_mentions" ADD CONSTRAINT "reply_mentions_workspace_user_id_workspace_users_id_fk" FOREIGN KEY ("workspace_user_id") REFERENCES "public"."workspace_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reply_mentions_user_idx" ON "reply_mentions" USING btree ("workspace_user_id");