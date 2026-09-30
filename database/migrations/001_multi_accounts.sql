-- 001: several social accounts per platform, and per-content destination accounts.
-- Additive only: no column or row is dropped. Existing data keeps working because
--   * the one account each platform had becomes that platform's default account,
--   * content with no chosen accounts publishes to the platform default (as before),
--   * existing scheduled posts are linked to the platform default account.
-- Rollback: 001_multi_accounts.down.sql (refuses to run if it would lose data).

ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

-- The oldest account of each platform becomes the default when none is marked yet.
UPDATE social_accounts s
SET is_default = true
WHERE s.id IN (
  SELECT DISTINCT ON (platform) id
  FROM social_accounts
  ORDER BY platform, created_at, id
)
AND NOT EXISTS (
  SELECT 1 FROM social_accounts d WHERE d.platform = s.platform AND d.is_default
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_accounts_one_default
  ON social_accounts(platform) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_social_accounts_external
  ON social_accounts(platform, external_account_id);

ALTER TABLE content ADD COLUMN IF NOT EXISTS account_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE automation_settings ADD COLUMN IF NOT EXISTS account_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS account_id uuid
  REFERENCES social_accounts(id) ON DELETE RESTRICT;

UPDATE scheduled_posts sp
SET account_id = sa.id
FROM social_accounts sa
WHERE sp.account_id IS NULL
  AND sa.platform = sp.platform
  AND sa.is_default;

-- One queue row per content + platform + account (was: per content + platform).
-- NULL account (no account connected yet) is folded into a fixed value so it stays unique.
ALTER TABLE scheduled_posts DROP CONSTRAINT IF EXISTS scheduled_posts_content_id_platform_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_posts_target
  ON scheduled_posts(content_id, platform, (COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid)));
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_account ON scheduled_posts(account_id);
