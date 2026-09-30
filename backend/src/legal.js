// Public pages that platform reviewers and users must be able to open without signing in:
// Privacy Policy, Terms of Service and the data deletion instructions/status page.
// The wording describes what this app actually does; keep it in sync with the code.

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function page(title, body, config) {
  const name = esc(config.appName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${name}</title>
<style>
  :root { color-scheme: light dark; --fg: #1d2530; --muted: #5b6573; --bg: #fbfbf8; --line: #d9dde3; --accent: #3d6690; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e8ecf1; --muted: #a3adba; --bg: #14181d; --line: #2b323b; --accent: #8db4dc; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.65 system-ui, -apple-system, "Segoe UI", "Noto Sans Thai", "Leelawadee UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
  h1 { font-size: 28px; margin: 0 0 4px; } h2 { font-size: 20px; margin: 32px 0 8px; } h3 { font-size: 16px; margin: 20px 0 4px; }
  .meta, .th { color: var(--muted); } .th { border-left: 3px solid var(--line); padding-left: 12px; }
  a { color: var(--accent); } nav { display: flex; gap: 16px; flex-wrap: wrap; padding-bottom: 16px; border-bottom: 1px solid var(--line); margin-bottom: 24px; }
  code { font-size: 14px; } .box { border: 1px solid var(--line); padding: 16px; border-radius: 6px; }
  .warn { border: 2px solid #c0392b; padding: 12px; color: #c0392b; }
</style>
</head>
<body><main>
<nav><strong>${name}</strong><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a><a href="/data-deletion">Data deletion</a><a href="/">Sign in</a></nav>
${config.appOperator && config.appContactEmail ? "" : `<p class="warn">Operator details are missing. Set APP_OPERATOR and APP_CONTACT_EMAIL in .env before submitting for review.</p>`}
${body}
</main></body></html>`;
}

function operatorLine(config) {
  return `${esc(config.appOperator || "[APP_OPERATOR]")} — <a href="mailto:${esc(config.appContactEmail)}">${esc(config.appContactEmail || "[APP_CONTACT_EMAIL]")}</a>`;
}

function privacyPage(config) {
  const updated = esc(config.legalUpdated || "2026-09-30");
  return page(
    "Privacy Policy",
    `<h1>Privacy Policy</h1>
<p class="meta">Last updated ${updated}. Operator: ${operatorLine(config)}</p>
<p>${esc(config.appName)} is a tool that helps its operator plan short videos, render them, and publish them to the operator's own YouTube, Facebook, Instagram and TikTok accounts. Only people who have been given a login by the operator can use it. By connecting an account you agree to this policy.</p>
<p class="th">${esc(config.appName)} เป็นเครื่องมือช่วยวางแผน สร้าง และเผยแพร่วิดีโอสั้นไปยังบัญชี YouTube, Facebook, Instagram และ TikTok ของผู้ดูแลระบบเอง การเชื่อมบัญชีถือว่ายอมรับนโยบายนี้</p>

<h2>Information we access and store</h2>
<ul>
<li><strong>Account connection data</strong>: the account or channel name and its platform ID, the permissions (scopes) you granted, and OAuth access/refresh tokens. Tokens are encrypted (AES-256-GCM) before they are stored.</li>
<li><strong>Content you create</strong>: topics, scripts, captions, hashtags, schedule times, and the rendered video files.</li>
<li><strong>Publishing records</strong>: the post ID returned by each platform, the time of posting, and error messages.</li>
<li><strong>Dashboard login</strong>: your email address and a hashed password; a session cookie keeps you signed in. We use no advertising or analytics cookies.</li>
</ul>
<p>We do not read your followers, messages, comments or viewing history.</p>

<h2>How we use it</h2>
<p>Only to do what you ask: generate and render videos, and upload a video to the accounts you choose after you approve that specific post. We never post without your approval, and we do not sell, rent or share your information for advertising.</p>

<h2>Service providers</h2>
<ul>
<li><strong>Anthropic (Claude API)</strong> receives the topic and settings you enter, to draft scripts and captions.</li>
<li><strong>Microsoft Edge text-to-speech</strong> receives the narration text, to produce the voice-over.</li>
<li><strong>YouTube, Meta (Facebook/Instagram) and TikTok</strong> receive the video and caption when you publish, through their official APIs.</li>
</ul>
<p>The application and its database run on the operator's own server.</p>

<h2>YouTube API Services</h2>
<p>This app uses YouTube API Services to upload videos to your channel. By using it you agree to the <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>. Google's handling of your data is described in the <a href="http://www.google.com/policies/privacy">Google Privacy Policy</a>. You can revoke this app's access at any time from <a href="https://security.google.com/settings/security/permissions">Google security settings</a>.</p>

<h2>Keeping and deleting data</h2>
<ul>
<li>Disconnecting an account in the dashboard deletes its tokens immediately and asks Google or TikTok to revoke them.</li>
<li>If you revoke access from Google, Facebook or TikTok settings instead, we delete the stored tokens and account data within 7 days. Data obtained from YouTube is refreshed or deleted within 30 days.</li>
<li>To have all of your data deleted, see <a href="/data-deletion">Data deletion</a> or email the operator. We complete deletion within 7 days.</li>
<li>Videos already published stay on the platform until you delete them there.</li>
</ul>

<h2>Security</h2>
<p>Traffic is served over HTTPS. Tokens are encrypted at rest, the database is not reachable from the internet, and access to the dashboard requires a login.</p>

<h2>Contact</h2>
<p>${operatorLine(config)}</p>`,
    config
  );
}

function termsPage(config) {
  const updated = esc(config.legalUpdated || "2026-09-30");
  return page(
    "Terms of Service",
    `<h1>Terms of Service</h1>
<p class="meta">Last updated ${updated}. Operator: ${operatorLine(config)}</p>
<ol>
<li><strong>What this is.</strong> ${esc(config.appName)} lets authorized users create short videos and publish them to social accounts they own or manage.</li>
<li><strong>Your accounts.</strong> Connect only accounts you own or are allowed to manage. You are responsible for everything published from your accounts.</li>
<li><strong>Your approval.</strong> Nothing is published until you review the preview and approve that post. You can edit the title, caption and hashtags, and choose platform settings, before approving.</li>
<li><strong>Platform rules.</strong> By publishing you agree to each platform's terms: <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>, <a href="https://www.facebook.com/terms.php">Meta Terms</a>, <a href="https://help.instagram.com/581066165581870">Instagram Terms of Use</a>, <a href="https://www.tiktok.com/legal/terms-of-service">TikTok Terms of Service</a>. Posts to TikTok are also subject to TikTok's <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en">Music Usage Confirmation</a> and, for branded content, the <a href="https://www.tiktok.com/legal/page/global/bc-policy/en">Branded Content Policy</a>.</li>
<li><strong>Acceptable use.</strong> No spam, misleading content, content you have no rights to, or anything that breaks the law or a platform's community guidelines. AI-generated drafts must be checked by you before approval.</li>
<li><strong>Availability.</strong> The service is provided as is. Platform APIs can change, limit or reject uploads at any time.</li>
<li><strong>Ending use.</strong> You can disconnect accounts and request deletion at any time; see the <a href="/privacy">Privacy Policy</a>.</li>
</ol>
<p class="th">การใช้งานถือว่ายอมรับเงื่อนไขของแต่ละแพลตฟอร์ม ระบบจะไม่โพสต์จนกว่าคุณจะดูตัวอย่างและกดอนุมัติโพสต์นั้น</p>`,
    config
  );
}

function deletionPage(config, request) {
  const status = request
    ? `<div class="box"><h2>Request ${esc(request.confirmation_code)}</h2>
<p>Status: <strong>${esc(request.status)}</strong>${request.completed_at ? ` on ${esc(new Date(request.completed_at).toISOString().slice(0, 10))}` : ""}</p>
<p>${esc(request.detail || "")}</p>
<p>Connected accounts cleared: ${esc(request.accounts_affected)}</p></div>`
    : "";
  return page(
    "Data deletion",
    `<h1>Data deletion</h1>
${status}
<h2>Delete your data</h2>
<ol>
<li><strong>From the dashboard</strong>: Social accounts → <em>Disconnect</em> deletes the tokens at once; <em>Delete</em> removes the account connection.</li>
<li><strong>Facebook / Instagram</strong>: Facebook → Settings &amp; privacy → Settings → Apps and websites → remove <em>${esc(config.appName)}</em> and choose to delete. We receive the request automatically and give you a confirmation code you can check on this page.</li>
<li><strong>YouTube</strong>: remove the app at <a href="https://security.google.com/settings/security/permissions">Google security settings</a>.</li>
<li><strong>TikTok</strong>: TikTok → Settings and privacy → Security → Apps and services → remove the app.</li>
<li><strong>Everything</strong>: email ${operatorLine(config)} from the address you use with us. We delete the data within 7 days and reply when done.</li>
</ol>
<p class="th">ลบข้อมูลได้จากหน้าบัญชีโซเชียลในแดชบอร์ด, จากการตั้งค่าแอปของแต่ละแพลตฟอร์ม หรืออีเมลถึงผู้ดูแล เราลบให้ภายใน 7 วัน</p>
<form method="get" action="/data-deletion"><label>Check a request: <input name="code" value="${esc(request?.confirmation_code || "")}" maxlength="40"></label> <button>Check</button></form>`,
    config
  );
}

module.exports = { privacyPage, termsPage, deletionPage, esc };
