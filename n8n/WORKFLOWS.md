# n8n Workflows

Create these workflows:

## 1. Daily Scheduler

Cron:
09:00 Asia/Bangkok

Steps:
1. Call backend `/api/automation/run-now`
2. Backend selects today's scheduled content
3. Trigger generation if asset is missing
4. Trigger publishing when ready

## 2. Generation

Webhook:
POST `/api/jobs/generation`

Steps:
1. Load content
2. Call Claude through backend
3. Validate JSON
4. Generate TTS
5. Build subtitles
6. FFmpeg
7. Quality check
8. Store result
9. Update status

## 3. Publishing

Webhook:
POST `/api/jobs/publish`

Steps:
1. Load social jobs
2. Check idempotency
3. Publish platform independently
4. Save external ID
5. Poll async status if necessary
6. Update result

## 4. Retry

Cron every 5–15 minutes.

Find retryable failed jobs.
Apply exponential backoff.
Never retry permanent errors.

## 5. Cleanup

Daily:
- delete temporary files
- delete stale generation jobs
- rotate logs according to retention policy
