CREATE TABLE "initiative_suggestions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "item_id" uuid NOT NULL,
  "initiative_id" uuid NOT NULL,
  "confidence" double precision NOT NULL,
  "reason" text,
  "status" varchar(16) NOT NULL DEFAULT 'pending',
  "model" varchar(64),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "decided_at" timestamp with time zone
);

ALTER TABLE "initiative_suggestions" ADD CONSTRAINT "init_sugg_item_fkey"
  FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE;
ALTER TABLE "initiative_suggestions" ADD CONSTRAINT "init_sugg_initiative_fkey"
  FOREIGN KEY ("initiative_id") REFERENCES "initiatives"("id") ON DELETE CASCADE;

CREATE INDEX "init_sugg_item_status_idx" ON "initiative_suggestions" ("item_id", "status");
CREATE INDEX "init_sugg_initiative_status_idx" ON "initiative_suggestions" ("initiative_id", "status");
