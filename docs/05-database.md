# 05 — Database Model

## Database choice

**Self-hosted PostgreSQL** running on the same Debian server as the application.

Do not use:
- Supabase
- Firebase
- hosted PostgreSQL
- a database service external to the server for the MVP

Deployment:
- PostgreSQL Docker image
- persistent `postgres_data` volume
- private Docker network
- application connection through `DATABASE_URL`
- n8n uses the same PostgreSQL server but a separate `n8n` schema

Schema source:
- `database/schema.sql`

Initialization:
- `database/init/01-init.sql`

## Tables

### users
- id
- email
- role
- password_hash
- created_at

### content
- id
- topic
- niche
- language
- tone
- duration_seconds
- hook
- script
- voice_script
- visual_prompt
- caption
- hashtags
- title
- cta
- status
- scheduled_at
- created_at
- updated_at

### media_assets
- id
- content_id
- type
- provider
- external_job_id
- storage_path
- storage_url
- mime_type
- width
- height
- duration_seconds
- file_size
- status
- created_at

### generation_jobs
- id
- content_id
- job_type
- provider
- status
- attempt
- error_code
- error_message
- started_at
- completed_at
- created_at

### social_accounts
- id
- platform
- account_name
- external_account_id
- access_token_encrypted
- refresh_token_encrypted
- expires_at
- scopes
- status
- created_at
- updated_at

### scheduled_posts
- id
- content_id
- platform
- scheduled_at
- status
- created_at

### social_posts
- id
- scheduled_post_id
- platform
- external_post_id
- status
- attempts
- last_error_code
- last_error_message
- published_at
- created_at
- updated_at

### automation_settings
- id
- enabled
- timezone
- daily_quantity
- publish_time
- generation_lead_days
- max_concurrent_jobs
- retry_count
- retry_backoff_seconds

### audit_logs
- id
- actor
- action
- entity_type
- entity_id
- metadata
- created_at

## Important indexes
- content(status)
- content(scheduled_at)
- scheduled_posts(scheduled_at, status)
- social_posts(platform, status)
- generation_jobs(status)
- audit_logs(created_at)

## Security
Never expose PostgreSQL credentials to the frontend.

OAuth tokens must be encrypted by the application before storage. Keep the encryption key outside the database.

PostgreSQL port 5432 must not be published to the public network.

## Backup
Back up PostgreSQL with `pg_dump` or another PostgreSQL-native backup method.

Example:
```bash
docker compose exec -T postgres pg_dump   -U "$POSTGRES_USER"   -d "$POSTGRES_DB"   --format=custom > backups/ai_social_$(date +%F).dump
```

Test restoration regularly.

## Migrations

`database/schema.sql` is the bootstrap schema. Changes after the first release live in `database/migrations/NNN_name.sql`.

- On every start the API applies `schema.sql`, then each migration that is not yet recorded in `schema_migrations`, in file-name order.
- Each migration runs in its own transaction. If one fails, it is rolled back and the API does not start, so the database is never left half-migrated.
- An advisory lock stops two app instances from migrating at the same time.
- `NNN_name.down.sql` is the rollback for that migration. It is never run automatically.

Back up before upgrading:

```bash
docker compose exec -T postgres pg_dump -U ai_social -d ai_social --format=custom > backups/before-upgrade.dump
docker compose up -d --build app
docker compose logs app | grep -i migration
```

To test migrations against a real database, run `TEST_DATABASE_URL=postgresql://... npm test` in `backend/`. The test runs in a throwaway schema.

### 001_multi_accounts

This migration allows several social accounts per platform and lets each content item choose its destination accounts. It only adds columns and indexes. No rows or values are changed, except for these back-fills:

| Table | Change | Existing data |
| --- | --- | --- |
| `social_accounts` | `is_default boolean` + unique index (one default per platform) | The oldest account of each platform becomes its default |
| `content` | `account_ids jsonb` (default `[]`) | `[]`, meaning "use the platform default", which is the previous behavior |
| `automation_settings` | `account_ids jsonb` (default `[]`) | `[]` |
| `scheduled_posts` | `account_id uuid` → `social_accounts(id)` `ON DELETE RESTRICT`; uniqueness changes from (content, platform) to (content, platform, account) | Linked to the platform's default account |

`ON DELETE RESTRICT` means an account that has queued or published posts cannot be deleted, which protects post history. Disconnect it instead. The API returns `409 IN_USE` if you try to delete one.

Rollback: `001_multi_accounts.down.sql` refuses to run while any platform has more than one account, or any content item is queued to several accounts on the same platform, because rolling back would lose those rows. Remove the extras first, run it, then deploy the previous app version.
