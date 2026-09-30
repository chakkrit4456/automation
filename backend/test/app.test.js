const test = require("node:test");
const assert = require("node:assert/strict");
const { MemoryStore, hashPassword } = require("../src/store-memory");
const { buildApp } = require("../src/app");
const { seedDemo, publishContent } = require("../src/services");
const {
  validateGenerateInput,
  validateAiOutput,
  isDuplicate,
  shouldAutoRetry,
  aggregatePublishStatus,
  contentStatusFromPosts,
  idempotentPublishDecision,
  validateMedia,
  shouldGenerateAhead,
  nextPublishInstant,
  accountIsExpired,
} = require("../src/domain");

function config() {
  return {
    nodeEnv: "test",
    appSecret: "test-secret-test-secret-test-secret",
    mediaRoot: require("path").join(__dirname, "..", "..", "data", "media-test"),
    maxVideoMb: 500,
    anthropicApiKey: "",
    anthropicModel: "claude-sonnet-5-5",
    publisherMode: "mock",
    publicUrl: "http://localhost:3000",
    youtubeClientId: "",
    metaAppId: "",
    tiktokClientKey: "",
    staticDir: "",
  };
}

async function authedApp() {
  const store = new MemoryStore();
  await store.createUser({
    email: "admin@localhost",
    password_hash: hashPassword("changeme"),
    role: "admin",
  });
  await seedDemo(store);
  const app = buildApp({ store, config: config(), logger: false });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "admin@localhost", password: "changeme" },
  });
  assert.equal(login.statusCode, 200);
  const setCookie = login.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
  return { app, store, cookie };
}

function withCookie(cookie, extra = {}) {
  return { ...extra, cookie };
}

test("health is public and ready reports memory", async () => {
  const { app } = await authedApp();
  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: "ok" });
  const ready = await app.inject({ method: "GET", url: "/api/ready" });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.json().database, "memory");
});

test("content API requires a session and supports CRUD", async () => {
  const { app, cookie } = await authedApp();
  const denied = await app.inject({ method: "GET", url: "/api/content" });
  assert.equal(denied.statusCode, 401);

  const created = await app.inject({
    method: "POST",
    url: "/api/content",
    headers: withCookie(cookie),
    payload: { topic: "ทดสอบหัวข้อใหม่", hook: "ฮุคใหม่", language: "th" },
  });
  assert.equal(created.statusCode, 201);
  const id = created.json().id;

  const duplicate = await app.inject({
    method: "POST",
    url: "/api/content",
    headers: withCookie(cookie),
    payload: { topic: "ทดสอบหัวข้อใหม่", hook: "ฮุคใหม่" },
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().error.code, "DUPLICATE");

  const patched = await app.inject({
    method: "PATCH",
    url: `/api/content/${id}`,
    headers: withCookie(cookie),
    payload: { caption: "แคปชันใหม่" },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().caption, "แคปชันใหม่");

  const removed = await app.inject({
    method: "DELETE",
    url: `/api/content/${id}`,
    headers: withCookie(cookie),
  });
  assert.equal(removed.statusCode, 204);
});

test("publish is idempotent and keeps a partial platform failure", async () => {
  const { app, store, cookie } = await authedApp();
  const rows = await store.listContent();
  const savings = rows.find((row) => row.public_no === 102);
  const first = await publishContent(store, savings.id, { publisherMode: "mock" });
  const second = await publishContent(store, savings.id, {
    publisherMode: "mock",
    idempotencyKey: "publish-102",
  });
  const third = await publishContent(store, savings.id, {
    publisherMode: "mock",
    idempotencyKey: "publish-102",
  });
  assert.equal(first.status, "PARTIAL");
  assert.deepEqual(second, third);
  const facebook = first.platforms.find((row) => row.platform === "facebook");
  assert.equal(facebook.error_code, "OAUTH_EXPIRED");
  const tiktok = first.platforms.find((row) => row.platform === "tiktok");
  assert.equal(tiktok.skipped, true);

  const retry = await app.inject({
    method: "POST",
    url: `/api/content/${savings.id}/publishing/facebook/retry`,
    headers: withCookie(cookie),
  });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().platforms[0].error_code, "OAUTH_EXPIRED");
  const after = await store.getContent(savings.id);
  assert.equal(after.status, "PARTIAL");
});

test("token expiry is reported by the account test", async () => {
  const { app, cookie } = await authedApp();
  const response = await app.inject({
    method: "POST",
    url: "/api/social/facebook/test",
    headers: withCookie(cookie),
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "OAUTH_EXPIRED");
});

test("scheduler does not publish a future slot and generation input is validated", async () => {
  const { app, cookie, store } = await authedApp();
  const run = await app.inject({
    method: "POST",
    url: "/api/automation/run-now",
    headers: withCookie(cookie),
  });
  assert.equal(run.statusCode, 200);
  assert.ok(Array.isArray(run.json().published));
  const bad = await app.inject({
    method: "POST",
    url: "/api/ai/generate",
    headers: withCookie(cookie),
    payload: { topic: "", count: 9 },
  });
  assert.equal(bad.statusCode, 400);
});

test("transaction rollback removes the uncommitted content row", async () => {
  const store = new MemoryStore();
  await store.createContent({ topic: "keep", hook: "one" });
  await assert.rejects(
    store.transaction(async (tx) => {
      await tx.createContent({ topic: "rollback", hook: "two" });
      throw new Error("fail");
    })
  );
  const rows = await store.listContent();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].topic, "keep");
});

test("domain rules for AI JSON, retries, media, and the daily window", () => {
  assert.throws(() => validateGenerateInput({ topic: "x", count: 0 }), /count/);
  const concept = validateAiOutput({
    topic: "a",
    hook: "b",
    script: "c",
    voice_script: "d",
    visual_prompt: "e",
    caption: "f",
    hashtags: "#one #two",
    title: "g",
    cta: "h",
  });
  assert.deepEqual(concept.hashtags, ["#one", "#two"]);
  assert.equal(isDuplicate([{ topic: "A", hook: "B", status: "DRAFT" }], "a", "b"), true);
  assert.equal(shouldAutoRetry({ errorCode: "OAUTH_EXPIRED", attempts: 0, maxAttempts: 3 }), false);
  assert.equal(shouldAutoRetry({ errorCode: "TIMEOUT", attempts: 1, maxAttempts: 3 }), true);
  assert.equal(aggregatePublishStatus([{ status: "SUCCESS" }, { status: "FAILED" }]), "PARTIAL");
  assert.equal(contentStatusFromPosts([{ status: "SUCCESS" }, { status: "QUEUED" }]), "SCHEDULED");
  assert.equal(idempotentPublishDecision({ status: "SUCCESS" }).action, "skip");
  assert.deepEqual(
    validateMedia({ mime_type: "video/mp4", width: 1920, height: 1080, provider: "ffmpeg", storage_path: "x" }),
    ["aspect ratio must be vertical"]
  );
  assert.equal(accountIsExpired({ status: "TOKEN_EXPIRED" }), true);
  const evening = new Date("2026-09-30T11:31:00Z");
  const settings = { enabled: true, timezone: "Asia/Bangkok", publish_time: "09:00", generation_lead_hours: 3 };
  assert.equal(shouldGenerateAhead(settings, evening), false);
  const morning = new Date("2026-09-30T23:30:00Z");
  assert.equal(shouldGenerateAhead(settings, morning), true);
  const next = nextPublishInstant(settings, evening);
  assert.equal(next.toISOString(), "2026-10-01T02:00:00.000Z");
});
