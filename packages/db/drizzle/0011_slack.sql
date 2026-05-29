ALTER TABLE "workspaces" ADD COLUMN "slack_team_id" text;
ALTER TABLE "workspaces" ADD COLUMN "slack_team_name" text;
ALTER TABLE "workspaces" ADD COLUMN "slack_bot_token" text;
ALTER TABLE "workspaces" ADD COLUMN "slack_bot_user_id" text;
ALTER TABLE "workspaces" ADD COLUMN "slack_installed_at" timestamp with time zone;

ALTER TABLE "workspace_users" ADD COLUMN "slack_user_id" text;
ALTER TABLE "workspace_users" ADD COLUMN "slack_lookup_failed_at" timestamp with time zone;
