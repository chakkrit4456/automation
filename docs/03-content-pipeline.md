# 03 — Content and Video Pipeline

## Daily workflow

```text
Scheduler
  |
  v
Find content scheduled for today
  |
  v
Validate content
  |
  v
Generate / obtain visual assets
  |
  v
Generate TTS
  |
  v
Generate subtitles
  |
  v
FFmpeg composition
  |
  v
Quality checks
  |
  v
Upload storage if required
  |
  v
Publish independently to each platform
  |
  v
Record result
```

## Content lifecycle

```text
DRAFT
  -> GENERATING
  -> READY
  -> SCHEDULED
  -> PROCESSING
  -> PUBLISHING
  -> PUBLISHED

Failure can move a job to:
FAILED
```

## Quality checks

Before publishing:
- file exists
- MP4 container valid
- video stream exists
- audio stream exists if required
- duration is within configured range
- aspect ratio is vertical
- resolution is acceptable
- file size is below platform limit
- no duplicate publish record exists
- content is not cancelled

## Recommended default video format

- container: MP4
- video codec: H.264
- audio codec: AAC
- aspect ratio: 9:16
- target: 1080x1920 when resources permit
- fallback: 720x1280
- audio sample rate: 44.1 kHz or 48 kHz
- frame rate: 30 fps unless source requires otherwise

## Subtitle pipeline

Option A:
- external TTS
- external or lightweight Whisper service
- FFmpeg burn-in

Option B:
- TTS provider returns timing metadata
- use timing metadata directly

The system must support both through adapters.

## Video provider abstraction

Interface:

```text
generateVideo(request)
getStatus(jobId)
download(jobId)
```

The provider must be replaceable.

Do not hard-code one provider into the core business logic.
