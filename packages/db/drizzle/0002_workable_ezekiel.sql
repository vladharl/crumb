CREATE EXTENSION IF NOT EXISTS pgcrypto;
ALTER TABLE "workspaces" ADD COLUMN "signing_secret" text DEFAULT encode(gen_random_bytes(32), 'hex') NOT NULL;
