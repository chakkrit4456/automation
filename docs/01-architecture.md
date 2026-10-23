# 01 — Architecture

## System overview

```text
Browser
  |
  v
Nginx
  |
  +--> Frontend
  |
  +--> Backend API
          |
          +--> Self-hosted PostgreSQL
          |
          +--> Ollama (free local model, 127.0.0.1:11434)
          |
          +--> n8n webhook/API
          |
          +--> Local media storage
          |
          +--> Publisher adapters
                    |
                    +--> TikTok API
                    +--> Instagram/Meta API
                    +--> Facebook/Meta API
                    +--> YouTube Data API

n8n
  |
  +--> Scheduler
  +--> Generation workflow
  +--> Publish workflow
  +--> Retry workflow
        |
        v
Self-hosted PostgreSQL
```

## Responsibilities

### Frontend
The dashboard is the single management interface.

It must never contain:
- AI provider keys (free tiers)
- OAuth client secrets
- Social access tokens
- PostgreSQL credentials

### Backend
Responsible for:
- authentication
- authorization
- content CRUD
- generation requests
- scheduling
- provider abstraction
- validation
- idempotency
- job state
- audit logs
- secure OAuth callbacks
- PostgreSQL access

### n8n
Responsible for orchestration:
- cron
- queues
- webhooks
- long-running workflows
- retries
- notifications
- calling backend endpoints

Do not put business rules only inside n8n. Important state must live in PostgreSQL/backend.

### PostgreSQL
PostgreSQL is self-hosted on the Debian server using Docker Compose.

Requirements:
- persistent Docker volume
- private Docker network
- no public 5432 exposure
- application uses a small connection pool
- n8n uses a separate `n8n` schema in the same PostgreSQL database
- database backups are scheduled outside the application container

### Media storage
Initial MVP stores media in a persistent Docker volume mounted at `/data/media`. A future object-storage adapter may be added when platform requirements or disk usage justify it.

### FFmpeg
Run short processing jobs only. Do not run multiple heavy FFmpeg jobs concurrently on the 1-vCPU server.

## Resource policy for 2 GB / 1 vCPU

Use:
- one worker at a time
- max 1 concurrent video-processing job
- low PostgreSQL connection pool
- short-lived FFmpeg processes
- no local LLM
- no local image-generation model
- one backend instance
- no Redis initially
- no Kubernetes

Avoid:
- Elasticsearch
- multiple application replicas
- unnecessary background workers
