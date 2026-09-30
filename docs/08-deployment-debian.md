# 08 — Debian Deployment

## Target

Debian server:
- 2 GB RAM
- 1 vCPU
- no local LLM
- Docker available

## Recommended layout

```text
/opt/ai-social-automation/
  docker-compose.yml
  .env
  backend/
  database/
  n8n/
  scripts/
  backups/
```

## Required packages

- Docker Engine
- Docker Compose plugin
- Nginx
- certbot if using Let's Encrypt
- PostgreSQL client (`postgresql-client`) for backup/restore operations

PostgreSQL server itself runs in Docker.

## Deployment

```bash
cd /opt/ai-social-automation
cp .env.example .env
chmod 600 .env

# Edit all passwords/secrets before starting.
nano .env

docker compose up -d postgres
docker compose ps
docker compose logs postgres

# Apply application schema.
docker compose exec -T postgres   psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"   < database/schema.sql

docker compose up -d app n8n
docker compose ps
```

If using the compose file exactly as supplied, `DATABASE_URL` should point to the service name `postgres`, not `localhost`.

## PostgreSQL policy

- PostgreSQL stays inside the Docker private network.
- Do not add `ports: 5432:5432` unless temporary administrative access is explicitly required.
- Use a strong random `POSTGRES_PASSWORD`.
- Use a persistent Docker volume.
- Back up with `pg_dump`.
- Keep database credentials out of Git.

## Application health

- `GET /api/health` verifies the process.
- `GET /api/ready` verifies PostgreSQL connectivity.

## Memory policy

Because RAM is only 2 GB:
- PostgreSQL memory limit: approximately 450 MB
- n8n memory limit: approximately 650 MB
- backend memory limit: approximately 350 MB
- one FFmpeg job at a time
- no local LLM
- no Redis initially
- no Kubernetes

Monitor actual RAM usage and tune limits if the workload changes.

## HTTPS

Production dashboard should use HTTPS.

Recommended:
Nginx -> Let's Encrypt -> frontend/backend.

n8n should not be publicly exposed without authentication and HTTPS.

## Backups

Create a daily PostgreSQL backup, for example:

```bash
mkdir -p /opt/ai-social-automation/backups

docker compose exec -T postgres   pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom   > "/opt/ai-social-automation/backups/ai_social_$(date +%F).dump"
```

Keep backups outside the PostgreSQL data volume when possible and define a retention policy.

## Health checks

Expose:
- `/api/health`
- `/api/ready`

Health endpoints must not leak secrets.
