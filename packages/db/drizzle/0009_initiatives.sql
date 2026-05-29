CREATE TABLE "initiatives" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "short_id" varchar(16) NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "status" varchar(16) NOT NULL DEFAULT 'open',
  "color" varchar(16),
  "owner_workspace_user_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "initiatives_workspace_id_short_id_key" UNIQUE ("workspace_id","short_id")
);

ALTER TABLE "initiatives" ADD CONSTRAINT "initiatives_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
ALTER TABLE "initiatives" ADD CONSTRAINT "initiatives_owner_workspace_user_id_fkey"
  FOREIGN KEY ("owner_workspace_user_id") REFERENCES "workspace_users"("id") ON DELETE SET NULL;

CREATE INDEX "initiatives_workspace_idx" ON "initiatives" ("workspace_id");

ALTER TABLE "items" ADD COLUMN "initiative_id" uuid;
ALTER TABLE "items" ADD CONSTRAINT "items_initiative_id_fkey"
  FOREIGN KEY ("initiative_id") REFERENCES "initiatives"("id") ON DELETE SET NULL;

ALTER TABLE "workspaces" ADD COLUMN "next_initiative_seq" integer NOT NULL DEFAULT 1;
