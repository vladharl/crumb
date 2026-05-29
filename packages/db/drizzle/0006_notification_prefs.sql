ALTER TABLE "workspace_users" ADD COLUMN "notifications_last_read_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "workspace_user_id" uuid PRIMARY KEY,
  "digest_frequency" varchar(16) NOT NULL DEFAULT 'daily',
  "new_submission_realtime" boolean NOT NULL DEFAULT true,
  "reply_realtime" boolean NOT NULL DEFAULT true,
  "mention_realtime" boolean NOT NULL DEFAULT true,
  "status_change_realtime" boolean NOT NULL DEFAULT false,
  "cluster_suggestions_realtime" boolean NOT NULL DEFAULT false,
  "delivery" varchar(16) NOT NULL DEFAULT 'email',
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "notification_preferences_workspace_user_id_fk"
    FOREIGN KEY ("workspace_user_id") REFERENCES "workspace_users"("id") ON DELETE CASCADE
);
