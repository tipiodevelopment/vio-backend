-- Sponsor ↔ Commerce business link (2026-09-16).
--
-- Commerce is the only place that creates accounts. A Commerce business or
-- supplier gets its Vio sponsor created automatically on its first call
-- (Firebase bearer, see server/middleware/authz.ts), and this column is the
-- stable link to that Commerce account: its Firebase uid (shared IdP,
-- ADR-0007). Unlike commerce_api_key it is not a secret and does not change
-- when a channel is recreated. Null for sponsors created by hand by an admin.
--
-- Idempotent (IF NOT EXISTS / duplicate_object guard), like 0007/0008.

ALTER TABLE "sponsors" ADD COLUMN IF NOT EXISTS "commerce_user_uid" varchar(128);
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "sponsors" ADD CONSTRAINT "sponsors_commerce_user_uid_unique" UNIQUE ("commerce_user_uid");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;
