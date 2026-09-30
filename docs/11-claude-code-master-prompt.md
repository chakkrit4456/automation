# Master Prompt for Claude Code

You are the lead engineer implementing the AI Social Automation platform described in this repository.

Read ALL files under:
- README.md
- docs/
- database/
- docker-compose.yml
- .env.example

Do not ask unnecessary questions.

## Goal

Build a production-ready web application that lets an administrator manage the complete workflow:

Content -> AI generation -> video pipeline -> scheduling -> social publishing -> monitoring.

Target deployment:
- Debian Linux
- 2 GB RAM
- 1 vCPU
- no local LLM
- self-hosted PostgreSQL on the same Debian server

## Critical architecture rules

1. Do not implement a local LLM.
2. Do not put secrets in frontend code.
3. Use external AI APIs for heavy AI work.
4. Use official social APIs when available.
5. Do not use scraping or CAPTCHA bypass.
6. Keep platform publishers independent.
7. Implement idempotency.
8. Persist job state in self-hosted PostgreSQL.
9. Limit concurrency to 1 for heavy media processing.
10. Keep the Debian server lightweight.
11. Do not add Supabase or Firebase.
12. Do not add a hosted database dependency.
13. PostgreSQL must run on the Debian server through Docker Compose with a persistent volume.
14. Do not expose PostgreSQL port 5432 publicly.

## Implementation process

1. Inspect the repository.
2. Read all documentation.
3. Detect existing framework/code.
4. Preserve working code.
5. Implement missing pieces.
6. Create/update PostgreSQL migrations/schema.
7. Implement backend APIs.
8. Implement frontend dashboard.
9. Implement provider interfaces.
10. Implement n8n workflow definitions.
11. Implement FFmpeg pipeline.
12. Implement mocked providers.
13. Add tests.
14. Run lint/typecheck/tests.
15. Fix all failures.
16. Build production assets.
17. Document external OAuth approval steps.
18. Verify the PostgreSQL deployment and backup/restore procedure.

## Database

Use `database/schema.sql`.

Use the standard PostgreSQL driver/ORM.

The application must connect through:
`DATABASE_URL`

Use a small pool, default maximum 5 connections.

Never use:
- Supabase SDK
- Firebase SDK
- Supabase Auth
- Supabase Storage

If authentication is required, implement it in the backend using PostgreSQL-backed application tables and secure password hashing/session handling.

## UI

Implement:
- Dashboard
- Content
- AI Generator
- Video Studio
- Calendar
- Automation
- Social Accounts
- Publishing
- Analytics
- Logs
- Settings

Follow docs/02-ui.md.

## Backend

Follow docs/06-api.md.

Use strong validation and structured errors.

## AI

Use Claude API only through a backend service.

Return structured validated JSON.

Do not assume Claude Pro provides API access.

## Video

Use provider abstraction and FFmpeg.

The core system must work with a mock provider first.

## Social

Implement interfaces first.

Use official APIs.

If an API requires manual app approval/OAuth setup, implement the integration and document the manual step rather than attempting to bypass it.

## Testing

Test:
- content CRUD
- JSON validation
- duplicate prevention
- idempotency
- retries
- partial platform failures
- token expiration
- scheduler
- media validation
- PostgreSQL connectivity
- transaction rollback where relevant

## Resource constraints

Target:
- 2 GB RAM
- 1 vCPU

Therefore:
- one worker
- one FFmpeg job
- small PostgreSQL connection pool
- no local LLM
- no unnecessary services
- no Redis unless a real requirement is demonstrated

## Completion requirement

Do not stop at a plan.

Actually create the application, run tests, fix errors, and leave a working development build.

At the end provide:
- implemented features
- remaining manual configuration
- environment variables required
- commands to run locally
- commands to deploy on Debian
- PostgreSQL backup/restore commands
- known limitations
