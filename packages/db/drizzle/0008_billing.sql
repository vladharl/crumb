ALTER TABLE "workspaces" ADD COLUMN "stripe_customer_id" text;
ALTER TABLE "workspaces" ADD COLUMN "stripe_subscription_id" text;
ALTER TABLE "workspaces" ADD COLUMN "subscription_status" varchar(32);
ALTER TABLE "workspaces" ADD COLUMN "current_period_end" timestamp with time zone;
ALTER TABLE "workspaces" ADD COLUMN "seats" integer NOT NULL DEFAULT 1;
ALTER TABLE "workspaces" ADD COLUMN "plan_id" varchar(32) NOT NULL DEFAULT 'free';
