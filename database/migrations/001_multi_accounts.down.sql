-- Rollback for 001_multi_accounts. Run by hand:
--   docker compose exec -T postgres psql -U ai_social ai_social < database/migrations/001_multi_accounts.down.sql
-- It stops without changing anything if rolling back would lose data, i.e. when a
-- platform has more than one account or a content item is queued to several accounts
-- on the same platform. Remove the extra accounts/queue rows first in that case.
-- Afterwards, deploy the previous app version (the current one re-applies 001 on start).

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT platform FROM social_accounts GROUP BY platform HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Rollback refused: some platforms have more than one account';
  END IF;
  IF EXISTS (
    SELECT content_id, platform FROM scheduled_posts GROUP BY content_id, platform HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Rollback refused: some content is queued to several accounts on one platform';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_scheduled_posts_target;
DROP INDEX IF EXISTS idx_scheduled_posts_account;
ALTER TABLE scheduled_posts ADD CONSTRAINT scheduled_posts_content_id_platform_key UNIQUE (content_id, platform);
ALTER TABLE scheduled_posts DROP COLUMN IF EXISTS account_id;

ALTER TABLE automation_settings DROP COLUMN IF EXISTS account_ids;
ALTER TABLE content DROP COLUMN IF EXISTS account_ids;

DROP INDEX IF EXISTS idx_social_accounts_external;
DROP INDEX IF EXISTS idx_social_accounts_one_default;
ALTER TABLE social_accounts DROP COLUMN IF EXISTS is_default;

DELETE FROM schema_migrations WHERE version = '001_multi_accounts';

COMMIT;
