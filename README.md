# AI Social Automation — Project Specification

## Run locally

```bash
node scripts/make-env.js --local      # .env with random secrets
pip install edge-tts                  # free Thai TTS; FFmpeg must also be on PATH
cd backend && npm install && npm test && npm run dev
cd frontend && npm install && npm run dev
```

Open http://localhost:5173 and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env`.
Without a `.env` in development, the defaults are `admin@localhost` / `changeme`.

Without `DATABASE_URL`, the API keeps state in memory and loads sample content.

## Deploy to the server (no Docker) — automation.itdev.in.th

```bash
bash install.sh   # as root on Debian 13 (trixie) standard or Debian 12, over SSH; DOMAIN=automation.itdev.in.th, uses your existing Cloudflare tunnel (no token needed)
```

Installs everything, including Ollama with a free open-weight model (`gemma3:4b`, or `qwen2.5:1.5b` under 6 GB RAM), plus swap, firewall, daily backups and a health check. Full steps: `docs/14-ขึ้นใช้งานจริง.md`. How to get the YouTube / Meta / TikTok keys: `docs/15-ขอคีย์โซเชียล.md`.

## Run the full stack with Docker (alternative)

```bash
node scripts/make-env.js              # then edit PUBLIC_URL and OAuth ids
docker compose up -d --build          # postgres + app (FFmpeg, Thai fonts, edge-tts) + ollama + n8n
docker compose exec ollama ollama pull gemma3:4b   # once: download the free model
```

The dashboard is at http://127.0.0.1:3000 and n8n at http://127.0.0.1:5678. Both bind to localhost only; put Nginx in front (`deploy/nginx/ai-social.conf`). PostgreSQL stays on the internal Docker network. Full steps are in `docs/14-ขึ้นใช้งานจริง.md`.

## What is wired up

| Stage | Implementation |
| --- | --- |
| Script | Free models only: Ollama on the server (default, no key), or the free tiers of Groq / Gemini / OpenRouter `:free` (`AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY`) |
| Voice | edge-tts (`TTS_VOICE`, Thai voices included), silent video if TTS is unavailable |
| Subtitles | Thai word segmentation, ASS styles burned in by FFmpeg, `.srt` sidecar saved |
| Video | FFmpeg 1080×1920 H.264/AAC MP4, one render at a time |
| Publish | YouTube resumable upload, Facebook Reels, Instagram Reels (resumable, no public URL needed), TikTok Direct Post |
| Accounts | OAuth with signed state, token exchange, encrypted storage, automatic refresh |
| Schedule | built-in minute scheduler and an n8n daily workflow (`n8n/workflows`) |

```bash
# backup
docker compose exec postgres pg_dump -U ai_social ai_social > backup.sql
# restore
docker compose exec -T postgres psql -U ai_social ai_social < backup.sql
```

Debian deploy steps remain in `docs/08-deployment-debian.md`. Build the dashboard with `npm run build` inside `frontend/` before starting the production API; the API serves `frontend/dist`.

OAuth approval steps are in `docs/13-oauth-setup.md`. n8n calls `POST /api/automation/run-now` with header `x-automation-token`.

# Specification

A production-oriented specification for an AI social-media automation platform designed for a small Debian server (2 GB RAM / 1 vCPU) without a local LLM.

## Goal

Create one web dashboard that manages:
- AI content generation
- Daily content scheduling
- Short-video generation pipeline
- TTS and subtitles
- FFmpeg video processing
- Content queue and calendar
- Social account connections
- Publishing to TikTok, Instagram Reels, Facebook Reels, and YouTube Shorts
- Per-platform publish status
- Retries and idempotency
- Logs and audit history
- Settings and analytics foundation

The Debian server is the application host. PostgreSQL runs on the same server and stores application state. Heavy AI work is done through external APIs/services. No local LLM is required.

## Target architecture

- Debian Linux
- Docker / Docker Compose
- Nginx
- Lightweight Node.js backend
- Web frontend
- Self-hosted PostgreSQL on the Debian server
- Self-hosted n8n
- Free AI models for content generation (self-hosted Ollama by default; no paid API)
- FFmpeg for video processing
- External/free-tier TTS or lightweight TTS
- Local persistent media directory initially; optional external object storage later
- Official social APIs whenever available

### Important database rule

**Do not use Supabase, Firebase, or another hosted database service.**

PostgreSQL is deployed directly on the Debian server through Docker Compose with a persistent volume. The application connects using `DATABASE_URL`.

PostgreSQL should not be exposed to the public Internet. Only the application and n8n containers should access it over the private Docker network.

## Resource policy

Target server (Debian 13 standard):
- 4 GB RAM minimum with `qwen2.5:1.5b`; 8 GB recommended for `gemma3:4b`
- 2 vCPU
- 20 GB disk

Keep:
- PostgreSQL connection pool small
- n8n concurrency at 1
- one FFmpeg job at a time
- one application instance
- no Redis initially
- no Kubernetes

Text generation runs on a small local model through Ollama (CPU is enough). There is no local image or video generation model.

## AI cost

Every AI step is free. Scripts come from an open-weight model served by Ollama on the same server. If the server is too small, `AI_PROVIDER` can point at the free tier of Groq, Google Gemini (use a Google project without billing) or OpenRouter (the app refuses models that do not end with `:free`). Voice-over uses free Microsoft Edge voices; video is rendered locally with FFmpeg.

## Non-goals for the first MVP

- Local image generation
- Local text-to-video generation
- Browser scraping of social platforms
- CAPTCHA bypass
- Automated account creation
- Spam or duplicate-content generation

## Suggested implementation order

1. Dashboard shell
2. Self-hosted PostgreSQL schema and migrations
3. Content CRUD
4. AI content generation (free models)
5. Video pipeline
6. Scheduler
7. Mock publishers
8. Real YouTube publisher
9. Meta publisher
10. TikTok publisher
11. Monitoring / retry / idempotency
12. Production hardening
