-- Align user_profiles with the fields used by src/api/server.ts and src/bot/bot.ts.
-- Migration 003 created the table without username / display_name / onboarded,
-- but the API reads and writes those columns (profile registration + Mini App).
-- A fresh DB built from migrations alone would therefore 500 on any profile
-- endpoint. Add the columns (idempotent — safe to re-run) + the uniqueness
-- indexes the API relies on for duplicate-check queries.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS username     TEXT,
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS onboarded    BOOLEAN DEFAULT false;

-- Partial unique indexes: allow NULLs (pre-registered rows) but prevent
-- duplicates among registered users. Matches what the API's 409 checks assume.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_username
  ON user_profiles (username) WHERE username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_email
  ON user_profiles (email) WHERE email IS NOT NULL;
