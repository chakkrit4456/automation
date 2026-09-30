-- Rollback for 002_publish_approval. Run by hand, then deploy the previous app version.
-- Refuses if Meta data deletion requests were received: that table is the record users
-- check their deletion status against, so it must be exported before it can be dropped.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM data_deletion_requests) THEN
    RAISE EXCEPTION 'Rollback refused: data_deletion_requests has rows. Export them first (COPY data_deletion_requests TO STDOUT), then delete them.';
  END IF;
END $$;

DROP TABLE IF EXISTS data_deletion_requests;
ALTER TABLE content DROP COLUMN IF EXISTS platform_options;
ALTER TABLE content DROP COLUMN IF EXISTS approved_by;
ALTER TABLE content DROP COLUMN IF EXISTS approved_at;

DELETE FROM schema_migrations WHERE version = '002_publish_approval';

COMMIT;
