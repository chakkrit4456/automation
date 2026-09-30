# 13 — OAuth setup

Publishing uses the official APIs. Client secrets stay in `.env`. Access and refresh tokens are encrypted with `APP_SECRET` (AES-256-GCM) before they are written to PostgreSQL. Every OAuth round trip carries a signed `state` value that expires after 10 minutes, and a callback with a missing or forged state is rejected.

Redirect URIs are built from `PUBLIC_URL`. Register exactly these in each developer console:

| Platform | Redirect URI |
| --- | --- |
| YouTube | `{PUBLIC_URL}/api/social/youtube/callback` |
| Facebook | `{PUBLIC_URL}/api/social/facebook/callback` |
| Instagram | `{PUBLIC_URL}/api/social/instagram/callback` |
| TikTok | `{PUBLIC_URL}/api/social/tiktok/callback` |

Meta and TikTok require HTTPS for production redirect URIs, so `PUBLIC_URL` must be your public `https://` domain. For local testing with Vite, use `http://localhost:5173` (Google accepts `http://localhost`).

After the credentials are in `.env`, restart the app. Open **Social accounts** and press **Connect** on a platform card. You sign in on the platform's page, and the app returns you to the dashboard with the account connected. Press **Test** to confirm that the stored token works. In `PUBLISHER_MODE=live` this calls the platform API.

Claude Pro does not include Anthropic API credits. Set `ANTHROPIC_API_KEY` separately.

## Several accounts per platform

Each platform can hold any number of accounts. The first account connected on a platform becomes its **default**, and you can change the default on the Social accounts page.

- **Adding accounts:** press **+ เพิ่มบัญชี** on the platform. Reconnecting an account the app already knows (same channel, Page, IG or TikTok id) updates that account instead of adding a duplicate.
  - **Facebook / Instagram:** the Facebook login dialog lets you tick several Pages. Every Page you grant becomes an account, and so does every linked Instagram professional account. `META_PAGE_ID` limits this to one Page.
  - **YouTube / TikTok:** one account per sign-in. To add another, sign out of that site first, or use a private window where you are signed in to the dashboard.
- **Choosing destinations:** the schedule dialog, the AI generator and the Automation page have a **บัญชีปลายทาง** picker. Accounts ticked for a platform all receive the video. If nothing is ticked for a platform, its default account is used.
- **Publishing:** each account is uploaded, retried and recorded separately. The Publishing page shows one status per account. An account that already has the post is never uploaded to again.
- **Changing destinations:** rescheduling with different accounts cancels the queue rows of the accounts you removed, unless they were already published.

## YouTube

1. In Google Cloud Console, create a project and enable **YouTube Data API v3**.
2. Configure the OAuth consent screen. Add your Google account as a test user while the app is in Testing.
3. Create an OAuth client of type **Web application** and add the YouTube redirect URI.
4. Set `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`. `YOUTUBE_PRIVACY` defaults to `public`.
5. Scopes requested: `youtube.upload` and `youtube.readonly`. The app asks for offline access, so it gets a refresh token and renews the 1-hour access token automatically.

Notes:
- Videos uploaded by an unverified API project are locked to private until Google completes an API audit. Request the audit in the Google Cloud console when you are ready.
- While the consent screen is in **Testing** mode, refresh tokens expire after 7 days. Publish the consent screen to avoid reconnecting every week.
- Each upload costs about 1,600 of the default 10,000 daily quota units, which is roughly 6 uploads per day.

## Meta (Facebook Page + Instagram)

1. Create a Meta app of type **Business** and add the **Facebook Login for Business** product.
2. Add both the Facebook and Instagram redirect URIs under Valid OAuth Redirect URIs.
3. Set `META_APP_ID` and `META_APP_SECRET`. If you manage several Pages, set `META_PAGE_ID` to choose one.
4. Permissions requested: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`, `business_management`.
5. Instagram must be a **professional (Business or Creator) account linked to a Facebook Page** you manage.

How it connects: the app exchanges the code for a long-lived user token, then stores the **Page token**, which does not expire. Facebook stores the Page id, and Instagram stores the linked Instagram user id.

How it publishes: Facebook Reels and Instagram Reels both use Meta's resumable upload (`rupload.facebook.com`). The MP4 is sent directly from the server, so no public video URL is needed.

App Review: accounts that have a role on the app (admin, developer, tester) can publish right away in Development mode. To publish for other accounts, submit the permissions above for App Review and complete Business Verification.

## TikTok

1. At developers.tiktok.com, create an app and add **Login Kit** and **Content Posting API** with Direct Post enabled.
2. Add the TikTok redirect URI. TikTok also requires verifying your domain.
3. Set `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET`.
4. Scopes requested: `user.info.basic`, `video.publish`, `video.upload`.

Unaudited apps can only post with `SELF_ONLY` (private) visibility. The app reads the creator's allowed privacy levels and falls back to `SELF_ONLY` automatically, so posts still succeed before the audit. Once TikTok approves the audit, `TIKTOK_PRIVACY=PUBLIC_TO_EVERYONE` takes effect. Access tokens last 24 hours and are refreshed automatically. The refresh token lasts 365 days, and that date appears as the expiry on the account card.

## Connecting with a pasted token

The form under the account cards stores an access token you already have, for example from the Graph API Explorer. For Facebook, enter the Page id. For Instagram, enter the Instagram user id. Pasted tokens are not refreshed.

## Mock versus live

- `PUBLISHER_MODE=mock`: no platform is called. Publishing is simulated so you can test scheduling, retries and the calendar.
- `PUBLISHER_MODE=live`: the latest rendered MP4 is uploaded through the official APIs. Content without a rendered MP4 fails with `MEDIA_MISSING`. An expired or revoked token marks the account `EXPIRED` and the post fails with `OAUTH_EXPIRED`, and neither is retried automatically. Network and 5xx errors (`UPSTREAM`) and rate limits (`RATE_LIMITED`) follow the retry count in Automation settings.
