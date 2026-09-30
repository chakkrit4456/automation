# 04 — Social Publishing

## Principle

Use official APIs whenever available and permitted.

Do not use:
- credential scraping
- CAPTCHA bypass
- fake browser fingerprints
- unofficial automation intended to evade platform restrictions

## Publisher interface

Every publisher should expose:

```text
connect()
refreshToken()
validateConnection()
publish(video, metadata)
getPublishStatus(externalId)
getAnalytics(externalId)
disconnect()
```

## TikTok

Implement an adapter around TikTok's official Content Posting API.

Required configuration:
- client key
- client secret
- redirect URI
- access token
- refresh token where applicable

The exact scopes, review/audit requirements, posting modes, limits and supported metadata must be verified against current TikTok developer documentation before production deployment.

## Instagram / Facebook

Use Meta Graph API flows appropriate to the connected account/page and Reel publishing capability.

Required configuration will depend on the Meta app and account type.

The implementation must:
- store external IDs
- handle asynchronous publishing
- poll status where required
- refresh/reconnect credentials
- record API errors

## YouTube

Use YouTube Data API.

Support:
- OAuth
- upload
- title
- description
- tags
- privacy
- category where configured
- publish status
- external video ID

Respect API quota.

## Platform independence

If TikTok fails and YouTube succeeds, do not roll back YouTube.

Each platform is an independent publish job.

Example:

```text
Content 102
  |
  +-- TikTok     FAILED
  +-- Instagram  SUCCESS
  +-- Facebook   SUCCESS
  +-- YouTube    SUCCESS
```

## Idempotency

Use a unique key:

```text
(content_id, platform, publish_attempt_group)
```

Before publishing:
1. query existing successful external post
2. if found, do not publish again
3. otherwise create a publishing job
4. persist state transitions
5. save external ID immediately after successful creation

## Retry

Retry only transient failures:
- HTTP 429
- temporary 5xx
- network timeout

Do not blindly retry:
- invalid OAuth
- invalid media
- permission denied
- malformed request

Use exponential backoff.
