# 08 — Debian Deployment

## Target

Debian 13 (trixie) standard server (Debian 12 also works):
- 8 GB RAM recommended (4 GB works with the `qwen2.5:1.5b` model)
- 2 vCPU, no GPU needed
- 20 GB disk
- free AI only: Ollama runs an open-weight model locally on `127.0.0.1:11434`

The supported path is the native installer, which needs no Docker:

```bash
apt update && apt install -y git
git clone https://github.com/chakkrit4456/automation.git && cd automation
bash install.sh
```

It installs Node.js 24, PostgreSQL 17, FFmpeg, Thai fonts, edge-tts, Ollama plus a free model, n8n, Nginx, systemd units, swap, ufw, fail2ban, backups and a health check. Details: `docs/14-ขึ้นใช้งานจริง.md`.

The Docker steps below are the alternative.

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

docker compose up -d ollama app n8n
docker compose exec ollama ollama pull gemma3:4b   # free model, once
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

On an 8 GB server:
- Ollama with `gemma3:4b`: approximately 4 GB while a request runs, unloaded after 10 idle minutes
- PostgreSQL memory limit: approximately 450 MB
- n8n memory limit: approximately 650 MB
- backend memory limit: approximately 350 MB
- one FFmpeg job and one AI request at a time
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
