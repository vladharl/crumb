CREATE TABLE IF NOT EXISTS "pending_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" varchar(64) NOT NULL,
	"workspace_name" text NOT NULL,
	"slug" varchar(64) NOT NULL,
	"admin_name" text NOT NULL,
	"admin_email" text NOT NULL,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_signups_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_signups_email_created_idx" ON "pending_signups" USING btree ("admin_email","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_signups_ip_created_idx" ON "pending_signups" USING btree ("ip","created_at");