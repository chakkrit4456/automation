const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MemoryStore, hashPassword } = require("../src/store-memory");
const { buildApp } = require("../src/app");
const services = require("../src/services");
const oauth = require("../src/oauth");
const publishers = require("../src/publishers");
const media = require("../src/media");

const SECRET = "test-secret-test-secret-test-secret";

function tempVideo(bytes = 1024) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pub-")), "clip.mp4");
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  return file;
}

// A fetch stand-in that answers from a list of [matcher, response] pairs and records calls.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const hit = routes.find(([match]) => (typeof match === "string" ? String(url).includes(match) : match.test(String(url))));
    if (!hit) throw new Error(`unexpected request ${url}`);
    const spec = typeof hit[1] === "function" ? hit[1](String(url), init, calls) : hit[1];
    const status = spec.status || 200;
    const headers = new Map(Object.entries(spec.headers || {}));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers.get(name.toLowerCase()) || null },
      text: async () => (spec.body === undefined ? "" : JSON.stringify(spec.body)),
    };
  };
  return { impl, calls };
}

test("captions split Thai at word boundaries and build valid ASS/SRT", () => {
  const chunks = media.captionChunks("ตื่นเช้าไม่ยากอย่างที่คิด ข้อแรก วางโทรศัพท์ไว้ไกลเตียง ข้อสอง ดื่มน้ำหนึ่งแก้ว");
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((line) => line.length <= 28));
  assert.equal(chunks.join("").replace(/\s/g, ""), "ตื่นเช้าไม่ยากอย่างที่คิดข้อแรกวางโทรศัพท์ไว้ไกลเตียงข้อสองดื่มน้ำหนึ่งแก้ว");
  const cues = media.timeline(chunks, 10);
  assert.ok(cues[0].start >= 0 && cues.at(-1).end <= 10);
  for (let i = 1; i < cues.length; i += 1) assert.ok(cues[i].start >= cues[i - 1].end - 1e-9);
  const ass = media.buildAss({ hook: "ฮุก {x}", cues, duration: 10, font: "Noto Sans Thai" });
  assert.match(ass, /Style: Sub,Noto Sans Thai/);
  assert.match(ass, /Dialogue: 1,0:00:00.00,0:00:10.00,Hook/);
  assert.doesNotMatch(ass, /\{x\}/);
  assert.match(media.buildSrt(cues), /^1\n00:00:00,200 --> /);
});

test("OAuth state is signed, bound to the platform, and expires", () => {
  const state = oauth.createState("youtube", SECRET);
  assert.equal(oauth.verifyState(state, "youtube", SECRET), true);
  assert.equal(oauth.verifyState(state, "tiktok", SECRET), false);
  assert.equal(oauth.verifyState(state, "youtube", "another-secret-another-secret"), false);
  assert.equal(oauth.verifyState(`${state}x`, "youtube", SECRET), false);
  assert.equal(oauth.verifyState(state, "youtube", SECRET, Date.now() + 11 * 60_000), false);
  const url = oauth.authorizeUrl("youtube", { youtubeClientId: "id", youtubeClientSecret: "s", publicUrl: "https://x.test" }, state);
  assert.match(url, /access_type=offline/);
  assert.match(url, /redirect_uri=https%3A%2F%2Fx.test%2Fapi%2Fsocial%2Fyoutube%2Fcallback/);
  assert.equal(oauth.authorizeUrl("youtube", { youtubeClientId: "id" }, state), null);
});

test("YouTube code exchange stores refresh token and channel", async () => {
  const { impl } = fakeFetch([
    ["oauth2.googleapis.com/token", { body: { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "a b" } }],
    ["youtube/v3/channels", { body: { items: [{ id: "UC1", snippet: { title: "My Channel" } }] } }],
  ]);
  const { accounts } = await oauth.exchangeCode("youtube", "code", { youtubeClientId: "id", youtubeClientSecret: "s", publicUrl: "https://x.test" }, impl);
  const [result] = accounts;
  assert.equal(accounts.length, 1);
  assert.equal(result.account_name, "My Channel");
  assert.equal(result.external_account_id, "UC1");
  assert.equal(result.tokens.refresh_token, "rt");
  assert.ok(new Date(result.tokens.access_expires_at) > new Date());
});

test("Meta exchange returns every granted Page, and only linked Instagram accounts", async () => {
  const { impl } = fakeFetch([
    ["fb_exchange_token", { body: { access_token: "long" } }],
    ["/me?fields=id", { body: { id: "fbuser1" } }],
    ["oauth/access_token", { body: { access_token: "short" } }],
    ["me/accounts", { body: { data: [
      { id: "p1", name: "Page One", access_token: "pt1" },
      { id: "p2", name: "Page Two", access_token: "pt2", instagram_business_account: { id: "ig2", username: "brand" } },
    ] } }],
  ]);
  const cfg = { metaAppId: "a", metaAppSecret: "b", publicUrl: "https://x.test" };
  const ig = await oauth.exchangeCode("instagram", "code", cfg, impl);
  assert.deepEqual(ig.accounts.map((row) => row.external_account_id), ["ig2"]);
  assert.equal(ig.accounts[0].tokens.access_token, "pt2");
  assert.equal(ig.accounts[0].tokens.meta_user_id, "fbuser1");
  const fb = await oauth.exchangeCode("facebook", "code", cfg, impl);
  assert.deepEqual(fb.accounts.map((row) => row.external_account_id), ["p1", "p2"]);
  const one = await oauth.exchangeCode("facebook", "code", { ...cfg, metaPageId: "p2" }, impl);
  assert.deepEqual(one.accounts.map((row) => row.account_name), ["Page Two"]);
});

test("upstream errors are classified for retry decisions", () => {
  assert.equal(oauth.upstreamError(401, {}, "x").code, "OAUTH_EXPIRED");
  assert.equal(oauth.upstreamError(400, { error: { code: 190, message: "expired" } }, "x").code, "OAUTH_EXPIRED");
  assert.equal(oauth.upstreamError(429, {}, "x").code, "RATE_LIMITED");
  assert.equal(oauth.upstreamError(503, {}, "x").code, "UPSTREAM");
  assert.equal(oauth.upstreamError(400, { error: { message: "bad" } }, "x").code, "PUBLISH_REJECTED");
});

test("YouTube upload uses a resumable session", async () => {
  const file = tempVideo(2048);
  const { impl, calls } = fakeFetch([
    ["uploadType=resumable", { headers: { location: "https://upload.test/session" }, body: {} }],
    ["upload.test/session", { body: { id: "vid123" } }],
  ]);
  const result = await publishers.publishYoutube({
    token: "t",
    content: { title: "Title", caption: "cap", hashtags: ["#a"] },
    video: { path: file },
    config: {},
    fetchImpl: impl,
  });
  assert.equal(result.external_id, "vid123");
  const meta = JSON.parse(calls[0].init.body);
  assert.match(meta.snippet.title, /#Shorts$/);
  assert.equal(calls[1].init.method, "PUT");
  assert.equal(calls[1].init.body.length, 2048);
});

test("Instagram Reels upload waits for processing then publishes", async () => {
  const file = tempVideo();
  let polls = 0;
  const { impl } = fakeFetch([
    ["/ig1/media_publish", { body: { id: "media9" } }],
    ["/ig1/media?", { body: { id: "c1", uri: "https://rupload.facebook.com/ig-api-upload/v23.0/c1" } }],
    ["rupload.facebook.com", { body: { success: true } }],
    ["/c1?fields=status_code", () => ({ body: { status_code: ++polls < 2 ? "IN_PROGRESS" : "FINISHED" } })],
  ]);
  const result = await publishers.publishInstagram({
    token: "t",
    account: { external_account_id: "ig1" },
    content: { caption: "hello" },
    video: { path: file },
    config: {},
    fetchImpl: impl,
    pollMs: 0,
  });
  assert.equal(result.external_id, "media9");
  assert.equal(polls, 2);
});

test("TikTok uses the privacy and interaction settings the user approved", async () => {
  const file = tempVideo(4096);
  const routes = () => fakeFetch([
    ["creator_info", { body: { data: { privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"], duet_disabled: true, max_video_post_duration_sec: 60 }, error: { code: "ok" } } }],
    ["video/init", { body: { data: { publish_id: "pub1", upload_url: "https://upload.tiktok.test/x" }, error: { code: "ok" } } }],
    ["upload.tiktok.test", { status: 201 }],
    ["status/fetch", { body: { data: { status: "PUBLISH_COMPLETE" }, error: { code: "ok" } } }],
  ]);
  const tiktok = { privacy_level: "PUBLIC_TO_EVERYONE", allow_comment: true, allow_duet: true, allow_stitch: false, commercial_disclosure: false };
  const { impl, calls } = routes();
  const result = await publishers.publishTiktok({
    token: "t",
    content: { caption: "c", platform_options: { tiktok } },
    video: { path: file, duration: 30 },
    fetchImpl: impl,
    pollMs: 0,
  });
  assert.equal(result.privacy, "PUBLIC_TO_EVERYONE");
  const init = JSON.parse(calls[1].init.body);
  assert.equal(init.post_info.privacy_level, "PUBLIC_TO_EVERYONE");
  assert.equal(init.post_info.disable_comment, false);
  assert.equal(init.post_info.disable_duet, true, "creator turned duet off, so it stays off");
  assert.equal(init.post_info.disable_stitch, true);
  assert.equal(init.post_info.brand_content_toggle, false);
  assert.equal(init.source_info.total_chunk_count, 1);
  assert.equal(calls[2].init.headers["content-range"], "bytes 0-4095/4096");
  assert.deepEqual(publishers.tiktokChunks(100 * 1024 * 1024), { chunkSize: 10 * 1024 * 1024, count: 10 });

  // No settings, a privacy level the creator does not allow, or a too-long video: no upload.
  for (const [options, duration, pattern] of [
    [undefined, 30, /choose TikTok post settings/],
    [{ ...tiktok, privacy_level: "MUTUAL_FOLLOW_FRIENDS" }, 30, /does not allow privacy/],
    [tiktok, 90, /allows up to 60s/],
  ]) {
    const again = routes();
    await assert.rejects(
      publishers.publishTiktok({ token: "t", content: { caption: "c", platform_options: { tiktok: options } }, video: { path: file, duration }, fetchImpl: again.impl, pollMs: 0 }),
      pattern
    );
    assert.equal(again.calls.filter((call) => call.url.includes("video/init")).length, 0);
  }
});

test("live publish refreshes an expired token and records the external id", async () => {
  const store = new MemoryStore();
  const content = await store.createContent({ topic: "t", hook: "h", caption: "c", platforms: ["youtube"], status: "READY" });
  await store.updateContent(content.id, { approved_at: new Date().toISOString(), approved_by: "test" });
  await store.createAsset({ content_id: content.id, type: "video", status: "READY", storage_path: tempVideo(), file_size: 1024 });
  await store.saveAccount("youtube", {
    status: "CONNECTED",
    account_name: "Chan",
    access_token_encrypted: services.sealTokens(
      { access_token: "old", refresh_token: "rt", access_expires_at: new Date(Date.now() - 1000).toISOString() },
      SECRET
    ),
  });
  let usedToken = null;
  const result = await services.publishContent(store, content.id, {
    publisherMode: "live",
    config: { appSecret: SECRET },
    deps: {
      refreshTokens: async (_platform, tokens) => ({ ...tokens, access_token: "new", access_expires_at: new Date(Date.now() + 3600e3).toISOString() }),
      publishLive: async (_platform, input) => {
        usedToken = input.token;
        return { external_id: "yt-1" };
      },
    },
  });
  assert.equal(usedToken, "new");
  assert.equal(result.status, "PUBLISHED");
  assert.equal(result.platforms[0].external_post_id, "yt-1");
  const saved = services.readTokens(await store.getAccountSecret((await store.getDefaultAccount("youtube")).id), SECRET);
  assert.equal(saved.access_token, "new");
});

test("live publish without a rendered file fails permanently with MEDIA_MISSING", async () => {
  const store = new MemoryStore();
  const content = await store.createContent({ topic: "t2", hook: "h2", platforms: ["facebook"], status: "READY" });
  await store.updateContent(content.id, { approved_at: new Date().toISOString() });
  await store.saveAccount("facebook", { status: "CONNECTED", access_token_encrypted: services.sealTokens({ access_token: "x" }, SECRET) });
  const result = await services.publishContent(store, content.id, { publisherMode: "live", config: { appSecret: SECRET } });
  assert.equal(result.platforms[0].error_code, "MEDIA_MISSING");
});

async function appWithLogin() {
  const store = new MemoryStore();
  await store.createUser({ email: "admin@localhost", password_hash: hashPassword("changeme"), role: "admin" });
  const app = buildApp({
    store,
    config: { nodeEnv: "test", appSecret: SECRET, publisherMode: "mock", publicUrl: "http://localhost:3000", staticDir: "", video: {} },
    logger: false,
  });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@localhost", password: "changeme" } });
  const setCookie = login.headers["set-cookie"];
  return { app, store, cookie: (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0] };
}

test("OAuth callback rejects a forged state and redirects back to the dashboard", async () => {
  const { app, cookie } = await appWithLogin();
  const response = await app.inject({ method: "GET", url: "/api/social/youtube/callback?code=abc&state=forged", headers: { cookie } });
  assert.equal(response.statusCode, 302);
  assert.match(response.headers.location, /oauth_error=.*#accounts$/);
});

test("media endpoint streams the rendered file with byte ranges", async () => {
  const { app, store, cookie } = await appWithLogin();
  const content = await store.createContent({ topic: "m", hook: "m" });
  const asset = await store.createAsset({ content_id: content.id, type: "video", status: "READY", storage_path: tempVideo(1000), mime_type: "video/mp4" });
  const full = await app.inject({ method: "GET", url: `/api/media/${asset.id}`, headers: { cookie } });
  assert.equal(full.statusCode, 200);
  assert.equal(full.rawPayload.length, 1000);
  const part = await app.inject({ method: "GET", url: `/api/media/${asset.id}`, headers: { cookie, range: "bytes=100-199" } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers["content-range"], "bytes 100-199/1000");
  assert.equal(part.rawPayload.length, 100);
  const anon = await app.inject({ method: "GET", url: `/api/media/${asset.id}` });
  assert.equal(anon.statusCode, 401);
});

async function twoFacebookPages(store) {
  const seal = (token) => services.sealTokens({ access_token: token }, SECRET);
  const a = await store.createAccount("facebook", { account_name: "Page A", status: "CONNECTED", access_token_encrypted: seal("ta") });
  const b = await store.createAccount("facebook", { account_name: "Page B", status: "CONNECTED", access_token_encrypted: seal("tb") });
  const yt = await store.createAccount("youtube", { account_name: "Chan", status: "CONNECTED", access_token_encrypted: seal("ty") });
  return { a, b, yt };
}

test("the first account of a platform becomes its default; default can move", async () => {
  const store = new MemoryStore();
  const { a, b } = await twoFacebookPages(store);
  assert.equal(a.is_default, true);
  assert.equal(b.is_default, false);
  await store.setDefaultAccount(b.id);
  assert.equal((await store.getDefaultAccount("facebook")).id, b.id);
  assert.equal((await store.getAccountById(a.id)).is_default, false);
  await store.deleteAccount(b.id);
  assert.equal((await store.getDefaultAccount("facebook")).id, a.id);
});

test("content with no chosen account goes to each platform's default account", async () => {
  const store = new MemoryStore();
  const { a, yt } = await twoFacebookPages(store);
  const content = { id: "c", platforms: ["facebook", "youtube"], account_ids: [] };
  const targets = services.resolveTargets(content, await store.listAccounts(), content.platforms);
  assert.deepEqual(targets.map((row) => row.account.id), [a.id, yt.id]);
});

test("chosen accounts publish separately and are recorded per account", async () => {
  const store = new MemoryStore();
  const { a, b, yt } = await twoFacebookPages(store);
  const content = await services.createContent(store, {
    topic: "multi",
    hook: "h",
    platforms: ["facebook", "youtube"],
    account_ids: [a.id, b.id],
    status: "READY",
  });
  assert.deepEqual(content.account_ids, [a.id, b.id]);
  await store.updateContent(content.id, { approved_at: new Date().toISOString() });
  await store.createAsset({ content_id: content.id, type: "video", status: "READY", storage_path: tempVideo(), file_size: 1024 });
  const used = [];
  const result = await services.publishContent(store, content.id, {
    publisherMode: "live",
    config: { appSecret: SECRET },
    deps: {
      publishLive: async (platform, input) => {
        used.push(`${platform}:${input.account.account_name}:${input.token}`);
        return { external_id: `x-${input.account.account_name}` };
      },
    },
  });
  assert.deepEqual(used.sort(), ["facebook:Page A:ta", "facebook:Page B:tb", "youtube:Chan:ty"]);
  assert.equal(result.status, "PUBLISHED");
  assert.deepEqual(result.platforms.map((row) => row.account_id).sort(), [a.id, b.id, yt.id].sort());
  const view = services.contentView(
    await store.getContent(content.id),
    [],
    await store.listScheduled(),
    await store.listPosts(),
    await store.listAccounts()
  );
  const facebook = view.publishing.filter((row) => row.platform === "facebook");
  assert.deepEqual(facebook.map((row) => [row.account_name, row.status]), [["Page A", "SUCCESS"], ["Page B", "SUCCESS"]]);

  // Publishing again does not post twice to any account.
  used.length = 0;
  await services.publishContent(store, content.id, { publisherMode: "live", config: { appSecret: SECRET }, deps: { publishLive: async () => { used.push(1); return { external_id: "dup" }; } } });
  assert.equal(used.length, 0);
});

test("unknown account ids are rejected; ids for unselected platforms are dropped", async () => {
  const store = new MemoryStore();
  const { a, yt } = await twoFacebookPages(store);
  await assert.rejects(services.cleanAccountIds(store, ["nope"], ["facebook"]), /Unknown account/);
  assert.deepEqual(await services.cleanAccountIds(store, [a.id, yt.id], ["facebook"]), [a.id]);
});

test("rescheduling to another account cancels the old queue row", async () => {
  const store = new MemoryStore();
  const { a, b } = await twoFacebookPages(store);
  const content = await services.createContent(store, { topic: "move", hook: "m", platforms: ["facebook"], account_ids: [a.id] });
  const when = new Date(Date.now() + 3600e3).toISOString();
  await services.scheduleContent(store, content.id, { scheduled_at: when, platforms: ["facebook"] });
  await services.scheduleContent(store, content.id, { scheduled_at: when, platforms: ["facebook"], account_ids: [b.id] });
  const rows = (await store.listScheduled()).filter((row) => row.content_id === content.id);
  const byAccount = Object.fromEntries(rows.map((row) => [row.account_id, row.status]));
  assert.equal(byAccount[a.id], "CANCELLED");
  assert.equal(byAccount[b.id], "SCHEDULED");
});

test("a queue row from before multi-account support is reused, not duplicated", async () => {
  const store = new MemoryStore();
  const { a } = await twoFacebookPages(store);
  const content = await store.createContent({ topic: "legacy", hook: "l", platforms: ["facebook"], status: "SCHEDULED" });
  const legacy = await store.upsertScheduled({ content_id: content.id, platform: "facebook", scheduled_at: new Date().toISOString() });
  assert.equal(legacy.account_id, null);
  await services.publishContent(store, content.id, { publisherMode: "mock" });
  const rows = (await store.listScheduled()).filter((row) => row.content_id === content.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, legacy.id);
  assert.equal(rows[0].account_id, a.id);
});

test("account API: list, set default, block delete when in use", async () => {
  const { app, store, cookie } = await appWithLogin();
  const { a, b } = await twoFacebookPages(store);
  const list = await app.inject({ method: "GET", url: "/api/social/accounts", headers: { cookie } });
  assert.equal(list.json().length, 3);
  const def = await app.inject({ method: "POST", url: `/api/social/accounts/${b.id}/default`, headers: { cookie } });
  assert.equal(def.json().is_default, true);
  const content = await services.createContent(store, { topic: "x", hook: "y", platforms: ["facebook"], account_ids: [a.id] });
  await services.scheduleContent(store, content.id, { scheduled_at: new Date().toISOString(), platforms: ["facebook"] });
  const blocked = await app.inject({ method: "DELETE", url: `/api/social/accounts/${a.id}`, headers: { cookie } });
  assert.equal(blocked.statusCode, 409);
  const manual = await app.inject({
    method: "POST",
    url: "/api/social/tiktok/connect",
    headers: { cookie },
    payload: { account_name: "tt", access_token: "tok", external_account_id: "open1" },
  });
  assert.equal(manual.statusCode, 200);
  const removed = await app.inject({ method: "DELETE", url: `/api/social/accounts/${manual.json().id}`, headers: { cookie } });
  assert.equal(removed.statusCode, 204);
});

const compliance = require("../src/compliance");
const { createHmac } = require("crypto");

test("live publishing waits for approval; mock mode does not", async () => {
  const store = new MemoryStore();
  await twoFacebookPages(store);
  const content = await services.createContent(store, { topic: "gate", hook: "g", platforms: ["facebook"] });
  let calls = 0;
  const deps = { publishLive: async () => { calls += 1; return { external_id: "x" }; } };
  const waiting = await services.publishContent(store, content.id, { publisherMode: "live", config: { appSecret: SECRET }, deps });
  assert.equal(waiting.status, "WAITING_APPROVAL");
  assert.equal(calls, 0);
  assert.equal((await store.listPosts()).length, 0, "nothing recorded while waiting");
  const mock = await services.publishContent(store, content.id, { publisherMode: "mock" });
  assert.equal(mock.status, "PUBLISHED");
});

test("approval needs a rendered video and valid TikTok choices", async () => {
  const store = new MemoryStore();
  const content = await services.createContent(store, { topic: "ap", hook: "a", platforms: ["tiktok", "youtube"] });
  await assert.rejects(services.approveContent(store, content.id, { user: "me" }), /Render the video/);
  await store.createAsset({ content_id: content.id, type: "video", status: "READY", storage_path: tempVideo(), file_size: 1024 });
  await assert.rejects(services.approveContent(store, content.id, { user: "me", publisherMode: "live" }), /Choose who can view/);
  await assert.rejects(
    services.approveContent(store, content.id, { publisherMode: "live", platform_options: { tiktok: { privacy_level: "SELF_ONLY", commercial_disclosure: true, branded_content: true } } }),
    /cannot be set to private/
  );
  await assert.rejects(
    services.approveContent(store, content.id, { publisherMode: "live", platform_options: { tiktok: { privacy_level: "PUBLIC_TO_EVERYONE", commercial_disclosure: true } } }),
    /choose Your brand/
  );
  const ok = await services.approveContent(store, content.id, {
    user: "me",
    publisherMode: "live",
    edits: { caption: "edited caption" },
    platform_options: { tiktok: { privacy_level: "PUBLIC_TO_EVERYONE", allow_comment: true, commercial_disclosure: true, your_brand: true } },
  });
  assert.ok(ok.approved_at);
  assert.equal(ok.approved_by, "me");
  assert.equal(ok.caption, "edited caption");
  assert.equal(ok.platform_options.tiktok.allow_duet, false, "unchecked by default");
  assert.equal(compliance.tiktokDeclaration(ok.platform_options.tiktok), "By posting, you agree to TikTok's Music Usage Confirmation");
  assert.equal(
    compliance.tiktokDeclaration({ branded_content: true }),
    "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation"
  );
});

test("approve API requires consent; editing text or re-rendering asks for approval again", async () => {
  const { app, store, cookie } = await appWithLogin();
  const content = await services.createContent(store, { topic: "re", hook: "r", platforms: ["youtube"] });
  await store.createAsset({ content_id: content.id, type: "video", status: "READY", storage_path: tempVideo() });
  const noConsent = await app.inject({ method: "POST", url: `/api/content/${content.id}/approve`, headers: { cookie }, payload: {} });
  assert.equal(noConsent.statusCode, 400);
  const ok = await app.inject({ method: "POST", url: `/api/content/${content.id}/approve`, headers: { cookie }, payload: { consent: true } });
  assert.equal(ok.statusCode, 200);
  assert.ok(ok.json().approved_at);
  // Changing something unrelated keeps the approval.
  await app.inject({ method: "PATCH", url: `/api/content/${content.id}`, headers: { cookie }, payload: { niche: "food" } });
  assert.ok((await store.getContent(content.id)).approved_at);
  // Changing the caption does not.
  await app.inject({ method: "PATCH", url: `/api/content/${content.id}`, headers: { cookie }, payload: { caption: "new words" } });
  assert.equal((await store.getContent(content.id)).approved_at, null);
  // Clients cannot approve by PATCH.
  await app.inject({ method: "PATCH", url: `/api/content/${content.id}`, headers: { cookie }, payload: { approved_at: new Date().toISOString() } });
  assert.equal((await store.getContent(content.id)).approved_at, null);
});

function signedRequest(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${sig}.${body}`;
}

test("Meta data deletion callback verifies the signature, clears tokens, and shows status", async () => {
  const store = new MemoryStore();
  await store.createUser({ email: "admin@localhost", password_hash: hashPassword("changeme"), role: "admin" });
  const config = { nodeEnv: "test", appSecret: SECRET, metaAppSecret: "meta-secret", publicUrl: "https://app.test", staticDir: "", video: {}, appOperator: "Op", appContactEmail: "op@example.com" };
  const app = buildApp({ store, config, logger: false });
  const mine = await store.createAccount("facebook", { account_name: "Mine", status: "CONNECTED", access_token_encrypted: services.sealTokens({ access_token: "p", meta_user_id: "u1" }, SECRET) });
  const other = await store.createAccount("instagram", { account_name: "Other", status: "CONNECTED", access_token_encrypted: services.sealTokens({ access_token: "q", meta_user_id: "u2" }, SECRET) });

  const forged = await app.inject({ method: "POST", url: "/api/meta/data-deletion", payload: `signed_request=${signedRequest({ algorithm: "HMAC-SHA256", user_id: "u1" }, "wrong")}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(forged.statusCode, 400);

  const response = await app.inject({
    method: "POST",
    url: "/api/meta/data-deletion",
    payload: `signed_request=${encodeURIComponent(signedRequest({ algorithm: "HMAC-SHA256", user_id: "u1", issued_at: 1 }, "meta-secret"))}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.match(body.confirmation_code, /^[0-9A-F]{18}$/);
  assert.equal(body.url, `https://app.test/data-deletion?code=${body.confirmation_code}`);
  assert.equal(await store.getAccountSecret(mine.id), null);
  assert.equal((await store.getAccountById(mine.id)).status, "DISCONNECTED");
  assert.ok(await store.getAccountSecret(other.id), "another Facebook user's account is untouched");

  const status = await app.inject({ method: "GET", url: `/data-deletion?code=${body.confirmation_code}` });
  assert.equal(status.statusCode, 200);
  assert.match(status.body, /COMPLETED/);
  assert.match(status.body, /Connected accounts cleared: 1/);
});

test("privacy, terms and data deletion pages are public and carry the required links", async () => {
  const { app } = await appWithLogin();
  const privacy = await app.inject({ method: "GET", url: "/privacy" });
  assert.equal(privacy.statusCode, 200);
  assert.match(privacy.headers["content-type"], /text\/html/);
  for (const link of ["https://www.youtube.com/t/terms", "http://www.google.com/policies/privacy", "https://security.google.com/settings/security/permissions"]) {
    assert.ok(privacy.body.includes(link), link);
  }
  assert.match(privacy.body, /Anthropic/);
  const terms = await app.inject({ method: "GET", url: "/terms" });
  assert.match(terms.body, /music-usage-confirmation/);
  const deletion = await app.inject({ method: "GET", url: "/data-deletion?code=<script>" });
  assert.equal(deletion.statusCode, 200);
  assert.doesNotMatch(deletion.body, /<script>/);
  assert.match(privacy.body, /Operator details are missing/, "warns until operator details are set");
});

test("disconnect revokes Google and TikTok tokens", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push([url, String(init.body)]); return { ok: true, status: 200 }; };
  const yt = await compliance.revokeTokens("youtube", { access_token: "a", refresh_token: "r" }, {}, fetchImpl);
  const tt = await compliance.revokeTokens("tiktok", { access_token: "t" }, { tiktokClientKey: "k", tiktokClientSecret: "s" }, fetchImpl);
  assert.equal(yt.revoked && tt.revoked, true);
  assert.deepEqual(calls[0], ["https://oauth2.googleapis.com/revoke", "token=r"]);
  assert.match(calls[1][1], /client_key=k&client_secret=s&token=t/);
  assert.equal((await compliance.revokeTokens("facebook", { access_token: "p" }, {}, fetchImpl)).revoked, false);
});
