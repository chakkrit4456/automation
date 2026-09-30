-- AI Social Automation - self-hosted PostgreSQL schema
-- Apply with:
--   psql "$DATABASE_URL" -f database/schema.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'admin',
  password_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS content (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL,
  niche text,
  language text NOT NULL DEFAULT 'th',
  tone text,
  duration_seconds integer,
  hook text,
  script text,
  voice_script text,
  visual_prompt text,
  caption text,
  hashtags jsonb NOT NULL DEFAULT '[]'::jsonb,
  title text,
  cta text,
  status text NOT NULL DEFAULT 'DRAFT',
  scheduled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id uuid NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  type text NOT NULL,
  provider text,
  external_job_id text,
  storage_path text,
  storage_url text,
  mime_type text,
  width integer,
  height integer,
  duration_seconds numeric,
  file_size bigint,
  status text NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id uuid NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  provider text,
  status text NOT NULL DEFAULT 'QUEUED',
  attempt integer NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS social_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL,
  account_name text,
  external_account_id text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  expires_at timestamptz,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'DISCONNECTED',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id uuid NOT NULL REFERENCES content(id) ON DELETE CASCADE,
  platform text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'SCHEDULED',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(content_id, platform)
);

CREATE TABLE IF NOT EXISTS social_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_post_id uuid NOT NULL REFERENCES scheduled_posts(id) ON DELETE CASCADE,
  platform text NOT NULL,
  external_post_id text,
  status text NOT NULL DEFAULT 'QUEUED',
  attempts integer NOT NULL DEFAULT 0,
  last_error_code text,
  last_error_message text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(scheduled_post_id, platform)
);

CREATE TABLE IF NOT EXISTS automation_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled boolean NOT NULL DEFAULT false,
  timezone text NOT NULL DEFAULT 'Asia/Bangkok',
  daily_quantity integer NOT NULL DEFAULT 1,
  publish_time time NOT NULL DEFAULT '09:00',
  generation_lead_days integer NOT NULL DEFAULT 3,
  max_concurrent_jobs integer NOT NULL DEFAULT 1,
  retry_count integer NOT NULL DEFAULT 3,
  retry_backoff_seconds integer NOT NULL DEFAULT 60
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_status ON content(status);
CREATE INDEX IF NOT EXISTS idx_content_scheduled ON content(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_time ON scheduled_posts(scheduled_at, status);
CREATE INDEX IF NOT EXISTS idx_social_posts_status ON social_posts(platform, status);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_status ON generation_jobs(status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);

-- Application extensions. Idempotent so Docker init and later startups can both apply them.

CREATE SEQUENCE IF NOT EXISTS content_public_no_seq START WITH 100;

ALTER TABLE content ADD COLUMN IF NOT EXISTS public_no integer;
ALTER TABLE content ADD COLUMN IF NOT EXISTS platforms jsonb NOT NULL DEFAULT '["tiktok","instagram","facebook","youtube"]'::jsonb;
ALTER TABLE content ADD COLUMN IF NOT EXISTS style text;
ALTER TABLE content ADD COLUMN IF NOT EXISTS target_audience text;
ALTER TABLE content ADD COLUMN IF NOT EXISTS shot_list text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_public_no ON content(public_no);

ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS fps integer;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS audio_status text;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS subtitle_status text;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS pipeline jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE automation_settings ADD COLUMN IF NOT EXISTS platforms jsonb NOT NULL DEFAULT '["tiktok","instagram","facebook","youtube"]'::jsonb;
ALTER TABLE automation_settings ADD COLUMN IF NOT EXISTS generation_lead_hours integer NOT NULL DEFAULT 3;

CREATE TABLE IF NOT EXISTS app_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level text NOT NULL,
  job text,
  content_id uuid,
  platform text,
  request_id text,
  message text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_logs_created ON app_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_level ON app_logs(level);

CREATE TABLE IF NOT EXISTS app_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  general jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai jsonb NOT NULL DEFAULT '{}'::jsonb,
  video jsonb NOT NULL DEFAULT '{}'::jsonb,
  storage jsonb NOT NULL DEFAULT '{}'::jsonb,
  social jsonb NOT NULL DEFAULT '{}'::jsonb,
  security jsonb NOT NULL DEFAULT '{}'::jsonb,
  notifications jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key text PRIMARY KEY,
  scope text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Keep application database credentials separate from the PostgreSQL superuser.
-- Do not expose PostgreSQL port 5432 to the public Internet.

-- Schema updates: for future changes, use versioned migration files rather than relying on
-- Docker's first-start initialization. Keep this file as the bootstrap schema for a fresh install.
