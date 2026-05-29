-- Phase 9: Linear / Jira / GitHub engineering integrations.

-- workspaces: per-provider install config (column-per-provider, mirrors Slack).
ALTER TABLE "workspaces" ADD COLUMN "linear_access_token" text;
ALTER TABLE "workspaces" ADD COLUMN "linear_team_id" text;
ALTER TABLE "workspaces" ADD COLUMN "linear_team_name" text;
ALTER TABLE "workspaces" ADD COLUMN "linear_installed_at" timestamp with time zone;

ALTER TABLE "workspaces" ADD COLUMN "jira_access_token" text;
ALTER TABLE "workspaces" ADD COLUMN "jira_refresh_token" text;
ALTER TABLE "workspaces" ADD COLUMN "jira_token_expires_at" timestamp with time zone;
ALTER TABLE "workspaces" ADD COLUMN "jira_cloud_id" text;
ALTER TABLE "workspaces" ADD COLUMN "jira_site_url" text;
ALTER TABLE "workspaces" ADD COLUMN "jira_default_project_key" text;
ALTER TABLE "workspaces" ADD COLUMN "jira_installed_at" timestamp with time zone;

ALTER TABLE "workspaces" ADD COLUMN "github_app_install_id" text;
ALTER TABLE "workspaces" ADD COLUMN "github_app_install_account" text;
ALTER TABLE "workspaces" ADD COLUMN "github_default_repo" text;
ALTER TABLE "workspaces" ADD COLUMN "github_installed_at" timestamp with time zone;

-- items: generalize the engineering link. Replace linear_id with external_*.
ALTER TABLE "items" ADD COLUMN "external_provider" varchar(16);
ALTER TABLE "items" ADD COLUMN "external_ticket_id" text;
ALTER TABLE "items" ADD COLUMN "external_ticket_url" text;
ALTER TABLE "items" ADD COLUMN "external_status" text;
ALTER TABLE "items" ADD COLUMN "external_synced_at" timestamp with time zone;

UPDATE "items"
SET    "external_provider"  = 'linear',
       "external_ticket_id" = "linear_id",
       "external_ticket_url" = 'https://linear.app/issue/' || "linear_id"
WHERE  "linear_id" IS NOT NULL;

ALTER TABLE "items" DROP COLUMN "linear_id";

-- ticket_suggestions: AI-drafted external tickets (mirror initiative_suggestions).
CREATE TABLE "ticket_suggestions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "item_id" uuid NOT NULL,
  "provider" varchar(16) NOT NULL,
  "draft_title" text NOT NULL,
  "draft_body" text NOT NULL DEFAULT '',
  "draft_labels" text[],
  "provider_target" text,
  "confidence" double precision NOT NULL,
  "reason" text,
  "status" varchar(16) NOT NULL DEFAULT 'pending',
  "model" varchar(64),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "decided_at" timestamp with time zone
);

ALTER TABLE "ticket_suggestions" ADD CONSTRAINT "ticket_sugg_item_fkey"
  FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE;

CREATE INDEX "ticket_sugg_item_status_idx" ON "ticket_suggestions" ("item_id", "status");
