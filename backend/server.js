const path = require("path");
const { MemoryStore, hashPassword } = require("./src/store-memory");
const { PgStore, ensureSchema, createPool } = require("./src/store-pg");
const { buildApp } = require("./src/app");
const { seedDemo, runAutomation, currentAi } = require("./src/services");

async function main() {
  const config = loadConfig();
  let store;
  let pool = null;
  if (config.databaseUrl) {
    pool = createPool(config.databaseUrl, config.dbPoolMax);
    await ensureSchema(pool);
    store = new PgStore(pool);
    await store.ping();
  } else if (config.nodeEnv === "production") {
    throw new Error("DATABASE_URL is required in production");
  } else {
    console.warn("DATABASE_URL is not set. Using in-memory state for local development.");
    store = new MemoryStore();
  }

  await ensureAdmin(store, config);
  if (config.seedDemo) await seedDemo(store);
  const ai = await currentAi(store, config);
  console.log(`AI text model: ${ai.provider} ${ai.model}${ai.baseUrl ? ` (${ai.baseUrl})` : ""}`);

  const app = buildApp({ store, config, logger: config.nodeEnv !== "test" });
  app.addHook("onClose", async () => {
    if (pool) await pool.end();
  });
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`listening on ${config.port}`);

  if (config.scheduler) {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      const automation = await store.getAutomation();
      if (!automation.enabled) return;
      running = true;
      try {
        await runAutomation(store, {
          publisherMode: config.publisherMode,
          ai: await currentAi(store, config),
          video: config.video,
          config,
        });
      } catch (error) {
        app.log.error(error);
      } finally {
        running = false;
      }
    }, 60_000);
    if (timer.unref) timer.unref();
  }
}

function loadConfig() {
  const nodeEnv = process.env.NODE_ENV || "development";
  const appSecret = process.env.APP_SECRET || "dev-only-secret-change-me";
  const adminPassword = process.env.ADMIN_PASSWORD || (nodeEnv === "production" ? "" : "changeme");
  if (nodeEnv === "production" && (!process.env.APP_SECRET || appSecret.length < 24)) {
    throw new Error("APP_SECRET must be set to a long random value in production");
  }
  if (nodeEnv === "production" && (!adminPassword || adminPassword === "changeme")) {
    throw new Error("ADMIN_PASSWORD must be set to a unique value in production");
  }
  const mediaRoot = process.env.MEDIA_ROOT || path.resolve(__dirname, "..", "data", "media");
  const maxVideoMb = Number(process.env.MAX_VIDEO_SIZE_MB || 500);
  return {
    nodeEnv,
    host: "0.0.0.0",
    port: Number(process.env.PORT || 3000),
    databaseUrl: process.env.DATABASE_URL || "",
    dbPoolMax: Number(process.env.DB_POOL_MAX || 5),
    appSecret,
    adminEmail: (process.env.ADMIN_EMAIL || "admin@localhost").toLowerCase(),
    adminPassword,
    seedDemo: process.env.SEED_DEMO ? process.env.SEED_DEMO === "true" : nodeEnv !== "production",
    scheduler: process.env.SCHEDULER ? process.env.SCHEDULER === "true" : nodeEnv !== "test",
    mediaRoot,
    maxVideoMb,
    video: {
      mediaRoot,
      maxMb: maxVideoMb,
      font: process.env.SUBTITLE_FONT || "Noto Sans Thai",
      fontsDir: process.env.SUBTITLE_FONTS_DIR || "",
      tts: {
        provider: process.env.TTS_PROVIDER || "edge",
        voice: process.env.TTS_VOICE || "th-TH-PremwadeeNeural",
        rate: process.env.TTS_RATE || "",
      },
    },
    // Free models only: ollama (local; production default), groq / gemini / openrouter free tiers, or mock (dev default).
    ai: {
      provider: process.env.AI_PROVIDER || (nodeEnv === "production" ? "ollama" : "mock"),
      model: process.env.AI_MODEL || "",
      baseUrl: process.env.AI_BASE_URL || "",
      apiKey: process.env.AI_API_KEY || "",
      timeoutMs: Number(process.env.AI_TIMEOUT_MS || 300_000),
    },
    publisherMode: process.env.PUBLISHER_MODE || "mock",
    publicUrl: process.env.PUBLIC_URL || "http://localhost:3000",
    automationToken: process.env.AUTOMATION_TOKEN || "",
    appName: process.env.APP_NAME || "SOCIAL / AUTO",
    appOperator: process.env.APP_OPERATOR || "",
    appContactEmail: process.env.APP_CONTACT_EMAIL || "",
    reviewerEmail: (process.env.REVIEWER_EMAIL || "").toLowerCase(),
    reviewerPassword: process.env.REVIEWER_PASSWORD || "",
    youtubeClientId: process.env.YOUTUBE_CLIENT_ID || "",
    youtubeClientSecret: process.env.YOUTUBE_CLIENT_SECRET || "",
    youtubePrivacy: process.env.YOUTUBE_PRIVACY || "public",
    metaAppId: process.env.META_APP_ID || "",
    metaAppSecret: process.env.META_APP_SECRET || "",
    metaPageId: process.env.META_PAGE_ID || "",
    metaGraphVersion: process.env.META_GRAPH_VERSION || "v23.0",
    tiktokClientKey: process.env.TIKTOK_CLIENT_KEY || "",
    tiktokClientSecret: process.env.TIKTOK_CLIENT_SECRET || "",
    tiktokPrivacy: process.env.TIKTOK_PRIVACY || "PUBLIC_TO_EVERYONE",
    staticDir: process.env.STATIC_DIR || path.resolve(__dirname, "..", "frontend", "dist"),
  };
}

async function ensureAdmin(store, config) {
  const users = [[config.adminEmail, config.adminPassword]];
  // A separate login for platform app reviewers (Meta App Review asks for test credentials).
  if (config.reviewerEmail && config.reviewerPassword) users.push([config.reviewerEmail, config.reviewerPassword]);
  for (const [email, password] of users) {
    if (await store.findUserByEmail(email)) continue;
    await store.createUser({ email, password_hash: hashPassword(password), role: "admin" });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { main, loadConfig };
