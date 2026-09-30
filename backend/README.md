# Backend

Implement the backend according to `docs/06-api.md`.

Recommended stack:
- Node.js + TypeScript
- Fastify or Express
- Zod for validation
- `pg` PostgreSQL driver or an equivalent PostgreSQL ORM/query builder
- structured logging

## Database

The backend uses **self-hosted PostgreSQL** on the same Debian server.

Use:
- `DATABASE_URL`
- small connection pool (`DB_POOL_MAX`, default 5)
- parameterized queries
- migrations/schema files under `database/`

Do not use:
- Supabase client
- Firebase
- hosted database-specific SDKs

Keep the API stateless where possible.

Important:
- never return OAuth tokens
- never expose database passwords or encryption keys
- use request IDs
- validate all external webhook signatures when applicable
