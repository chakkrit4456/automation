-- 002: explicit per-post approval (required by YouTube, TikTok and Meta policies before an
-- app uploads on a user's behalf), per-platform post options (TikTok privacy, interactions,
-- commercial disclosure), and a log of Meta data deletion requests.
-- Additive only. Existing content starts unapproved, which only matters in PUBLISHER_MODE=live.
-- Rollback: 002_publish_approval.down.sql

ALTER TABLE content ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE content ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE content ADD COLUMN IF NOT EXISTS platform_options jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS data_deletion_requests (
  confirmation_code text PRIMARY KEY,
  platform text NOT NULL,
  external_user_id text NOT NULL,
  status text NOT NULL DEFAULT 'RECEIVED',
  accounts_affected integer NOT NULL DEFAULT 0,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
