# 06 — Backend API Contract

All API responses should use JSON. Application state is stored in self-hosted PostgreSQL through the backend; database credentials are never returned to clients.

## Health

GET /api/health

Response:
```json
{"status":"ok"}
```

## Dashboard

GET /api/dashboard/summary

Returns:
- today's counts
- next scheduled content
- platform status
- recent failures

## Content

GET /api/content
POST /api/content
GET /api/content/:id
PATCH /api/content/:id
DELETE /api/content/:id

## Generate content

POST /api/ai/generate

Request:
```json
{
  "topic": "skincare",
  "niche": "beauty",
  "language": "th",
  "duration_seconds": 45,
  "tone": "friendly",
  "count": 1
}
```

## Generate video

POST /api/content/:id/video

## Schedule

POST /api/content/:id/schedule

Request:
```json
{
  "scheduled_at": "2026-10-01T09:00:00+07:00",
  "platforms": ["tiktok", "instagram", "facebook", "youtube"]
}
```

## Publish now

POST /api/content/:id/publish

## Publishing status

GET /api/content/:id/publishing

## Social accounts

GET /api/social/accounts
POST /api/social/:platform/connect
GET /api/social/:platform/callback
POST /api/social/:platform/test
POST /api/social/:platform/disconnect

## Automation

GET /api/automation/settings
PATCH /api/automation/settings
POST /api/automation/run-now

## Jobs

GET /api/jobs
GET /api/jobs/:id
POST /api/jobs/:id/retry

## Logs

GET /api/logs


## Database health

GET /api/ready

Returns HTTP 200 only when the backend can reach PostgreSQL. Returns HTTP 503 otherwise.
