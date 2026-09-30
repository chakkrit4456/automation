# 12 — Example Daily Workflow

Assume:

- timezone: Asia/Bangkok
- one video/day
- publish at 09:00
- platforms: TikTok, Instagram, Facebook, YouTube

## 08:00

Scheduler checks content queue.

If today's content is missing:
- generate concept
- generate script
- create media assets

## 08:30

Video pipeline:
- TTS
- subtitles
- FFmpeg
- quality check

## 08:50

Upload media if required.

## 09:00

Create one publish job per platform.

```text
content #102
  |
  +-- tiktok
  +-- instagram
  +-- facebook
  +-- youtube
```

## 09:01+

Each platform is tracked independently.

Example:

```text
TikTok       SUCCESS
Instagram    SUCCESS
Facebook     RETRY
YouTube      SUCCESS
```

Facebook can retry without reposting the successful platforms.

## End of day

Dashboard displays:
- generated
- published
- failed
- retries
- errors
- platform IDs
