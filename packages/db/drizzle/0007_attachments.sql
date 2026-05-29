CREATE TABLE IF NOT EXISTS "attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "reply_id" uuid,
  "filename" text NOT NULL,
  "content_type" varchar(128) NOT NULL,
  "size_bytes" integer NOT NULL,
  "storage_key" text NOT NULL,
  "uploaded_by_workspace_user_id" uuid,
  "uploaded_by_account_user_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "attachments_reply_id_fk"
    FOREIGN KEY ("reply_id") REFERENCES "replies"("id") ON DELETE CASCADE,
  CONSTRAINT "attachments_uploaded_by_workspace_user_id_fk"
    FOREIGN KEY ("uploaded_by_workspace_user_id") REFERENCES "workspace_users"("id") ON DELETE SET NULL,
  CONSTRAINT "attachments_uploaded_by_account_user_id_fk"
    FOREIGN KEY ("uploaded_by_account_user_id") REFERENCES "account_users"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "attachments_reply_idx" ON "attachments"("reply_id");
