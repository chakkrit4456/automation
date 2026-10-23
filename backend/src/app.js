const fs = require("fs");
const path = require("path");
const { randomBytes, randomUUID } = require("crypto");
const Fastify = require("fastify");
const {
  validateGenerateInput,
  normalizePlatforms,
  PLATFORMS,
  httpError,
  tzDateKey,
} = require("./domain");
const { hashPassword, verifyPassword, hashToken } = require("./store-memory");
const services = require("./services");
const oauth = require("./oauth");
const { verifyAccount, tiktokCreatorInfo } = require("./publishers");
const compliance = require("./compliance");
const legal = require("./legal");
const { AI_PRESETS, resolveAi, testAi } = require("./providers");

const SETTINGS_SECTIONS = ["general", "ai", "video", "storage", "social", "security", "notifications"];

function buildApp(options) {
  const store = options.store;
  const config = options.config;
  const app = Fastify({ logger: options.logger === true });
  const hits = new Map();
  const legalConfig = {
    appName: config.appName || "SOCIAL / AUTO",
    appOperator: config.appOperator || "",
    appContactEmail: config.appContactEmail || "",
    legalUpdated: config.legalUpdated,
  };

  // Meta posts its callbacks as HTML form data.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body)));
  });

  app.setErrorHandler((error, request, reply) => {
    const status = error.status || (error.validation ? 400 : error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500);
    const code = error.code && error.status ? error.code : status === 400 ? "VALIDATION" : status === 500 ? "INTERNAL" : "REQUEST";
    request.log?.error?.(error);
    const body = {
      error: {
        code,
        message: status === 500 ? "Unexpected server error" : error.message,
      },
    };
    if (error.details) body.error.details = error.details;
    reply.code(status).send(body);
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS") {
      reply.code(204).send();
      return;
    }
    const open = request.url.startsWith("/api/health")
      || request.url.startsWith("/api/ready")
      || request.url.startsWith("/api/auth/login")
      || request.url.startsWith("/api/meta/");
    if (!request.url.startsWith("/api/") || open) return;
    if (config.automationToken && request.headers["x-automation-token"] === config.automationToken) {
      request.user = { email: "automation", role: "automation" };
      return;
    }
    const token = readCookie(request, "sid");
    const user = token ? await store.getSession(hashToken(token)) : null;
    if (!user) throw httpError(401, "UNAUTHORIZED", "Sign in required");
    request.user = user;
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  app.get("/api/ready", async (_request, reply) => {
    try {
      if (store.ping) await store.ping();
      return { status: "ready", database: store.ping ? "ok" : "memory" };
    } catch {
      reply.code(503);
      return { status: "not_ready", database: "error" };
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    const email = String(request.body?.email || "").trim().toLowerCase();
    const password = String(request.body?.password || "");
    const user = await store.findUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw httpError(401, "UNAUTHORIZED", "Email or password is incorrect");
    }
    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await store.createSession(user.id, hashToken(token), expires);
    reply.header("Set-Cookie", cookieHeader(token, config));
    return { email: user.email, role: user.role };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = readCookie(request, "sid");
    if (token) await store.deleteSession(hashToken(token));
    reply.header("Set-Cookie", "sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
    return { status: "ok" };
  });

  app.get("/api/auth/me", async (request) => ({ email: request.user.email, role: request.user.role }));

  app.get("/api/dashboard/summary", async () => services.dashboardSummary(store));

  app.get("/api/content", async (request) => {
    const data = await services.bundle(store);
    const status = request.query.status;
    const q = String(request.query.q || "").trim().toLowerCase();
    return data.content
      .filter((row) => !status || status === "ALL" || row.status === status)
      .filter((row) => !q || `${row.topic} ${row.title || ""} ${row.hook || ""}`.toLowerCase().includes(q))
      .map((row) => services.contentView(row, data.assets, data.scheduled, data.posts, data.accounts));
  });

  app.post("/api/content", async (request, reply) => {
    const body = request.body || {};
    if (!String(body.topic || "").trim()) throw httpError(400, "VALIDATION", "topic is required");
    const created = await services.createContent(store, {
      ...body,
      topic: String(body.topic).trim(),
      hashtags: body.hashtags || [],
      platforms: body.platforms ? normalizePlatforms(body.platforms) : PLATFORMS,
    });
    reply.code(201);
    return created;
  });

  app.get("/api/content/:id", async (request) => {
    const row = await loadContentView(store, request.params.id);
    if (!row) throw httpError(404, "NOT_FOUND", "Content not found");
    return row;
  });

  app.patch("/api/content/:id", async (request) => {
    const current = await store.getContent(request.params.id);
    if (!current) throw httpError(404, "NOT_FOUND", "Content not found");
    const patch = { ...request.body };
    if (patch.platforms) patch.platforms = normalizePlatforms(patch.platforms);
    delete patch.approved_at;
    delete patch.approved_by;
    delete patch.platform_options;
    if (patch.account_ids !== undefined || patch.platforms) {
      patch.account_ids = await services.cleanAccountIds(
        store,
        patch.account_ids ?? current.account_ids ?? [],
        patch.platforms || current.platforms || PLATFORMS
      );
    }
    delete patch.id;
    delete patch.public_no;
    if (current.approved_at && compliance.approvalInvalidated(current, patch)) {
      // The user approved different text or destinations; ask again.
      patch.approved_at = null;
      patch.approved_by = null;
    }
    return store.updateContent(current.id, patch);
  });

  app.delete("/api/content/:id", async (request, reply) => {
    const ok = await store.deleteContent(request.params.id);
    if (!ok) throw httpError(404, "NOT_FOUND", "Content not found");
    reply.code(204);
    return null;
  });

  app.post("/api/content/:id/duplicate", async (request, reply) => {
    const current = await store.getContent(request.params.id);
    if (!current) throw httpError(404, "NOT_FOUND", "Content not found");
    const copy = await store.createContent({
      ...current,
      id: undefined,
      public_no: undefined,
      topic: `${current.topic} (สำเนา)`,
      hook: current.hook ? `${current.hook} (สำเนา)` : null,
      status: "DRAFT",
      scheduled_at: null,
    });
    reply.code(201);
    return copy;
  });

  app.post("/api/content/:id/cancel", async (request) => {
    const current = await store.getContent(request.params.id);
    if (!current) throw httpError(404, "NOT_FOUND", "Content not found");
    return store.updateContent(current.id, { status: "CANCELLED" });
  });

  app.post("/api/ai/generate", async (request) => {
    limit(hits, request.ip, "generate", 30);
    const input = validateGenerateInput(request.body);
    const savedMode = request.body?.save || null;
    return services.generateAndOptionallySave(store, input, {
      ai: await services.currentAi(store, config),
      save: savedMode === "draft" || savedMode === "queue",
      queue: savedMode === "queue",
      scheduledAt: request.body?.scheduled_at || null,
    });
  });

  app.post("/api/content/:id/video", async (request, reply) => {
    limit(hits, request.ip, "video", 10);
    const result = await services.renderVideo(store, request.params.id, config.video);
    reply.code(201);
    return result;
  });

  app.post("/api/content/:id/schedule", async (request) => {
    const platforms = normalizePlatforms(request.body?.platforms || PLATFORMS);
    return services.scheduleContent(store, request.params.id, {
      scheduled_at: request.body?.scheduled_at,
      platforms,
      account_ids: request.body?.account_ids,
    });
  });

  app.post("/api/content/:id/publish", async (request) => {
    limit(hits, request.ip, "publish", 20);
    const platforms = request.body?.platforms ? normalizePlatforms(request.body.platforms) : undefined;
    return services.publishContent(store, request.params.id, {
      platforms,
      idempotencyKey: request.headers["idempotency-key"] || request.body?.idempotency_key || null,
      publisherMode: config.publisherMode,
      config,
      force: false,
    });
  });

  app.post("/api/content/:id/approve", async (request) => {
    const body = request.body || {};
    if (body.consent !== true) {
      throw httpError(400, "VALIDATION", "Confirm that you reviewed the preview and agree to post");
    }
    const saved = await services.approveContent(store, request.params.id, {
      user: request.user?.email,
      edits: body.edits,
      platform_options: body.platform_options,
      publisherMode: config.publisherMode,
    });
    return loadContentView(store, saved.id);
  });

  app.post("/api/content/:id/unapprove", async (request) => {
    const current = await store.getContent(request.params.id);
    if (!current) throw httpError(404, "NOT_FOUND", "Content not found");
    await store.updateContent(current.id, { approved_at: null, approved_by: null });
    return loadContentView(store, current.id);
  });

  app.get("/api/content/:id/publishing", async (request) => {
    const row = await loadContentView(store, request.params.id);
    if (!row) throw httpError(404, "NOT_FOUND", "Content not found");
    return { content_id: row.id, public_no: row.public_no, topic: row.topic, platforms: row.publishing };
  });

  app.post("/api/content/:id/publishing/:platform/retry", async (request) => {
    const platform = String(request.params.platform || "").toLowerCase();
    normalizePlatforms([platform]);
    const accountId = request.body?.account_id || request.query.account_id || null;
    return services.publishContent(store, request.params.id, {
      platforms: [platform],
      targets: accountId ? [{ platform, account_id: String(accountId) }] : undefined,
      publisherMode: config.publisherMode,
      config,
      force: true,
    });
  });

  app.get("/api/publishing", async () => {
    const data = await services.bundle(store);
    return data.content.map((row) => services.contentView(row, data.assets, data.scheduled, data.posts, data.accounts));
  });

  app.get("/api/calendar", async (request) => {
    const data = await services.bundle(store);
    return data.content
      .filter((row) => row.scheduled_at)
      .map((row) => services.contentView(row, data.assets, data.scheduled, data.posts, data.accounts))
      .filter((row) => {
        const key = tzDateKey(new Date(row.scheduled_at), request.query.timezone || "Asia/Bangkok");
        if (request.query.from && key < request.query.from) return false;
        if (request.query.to && key > request.query.to) return false;
        return true;
      });
  });

  app.get("/api/social/accounts", async () => {
    const [accounts, scheduled, posts] = await Promise.all([store.listAccounts(), store.listScheduled(), store.listPosts()]);
    return accounts.map((account) => {
      const mine = new Set(scheduled.filter((row) => row.account_id === account.id).map((row) => row.id));
      const latest = posts
        .filter((row) => mine.has(row.scheduled_post_id) && row.published_at)
        .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))[0];
      return { ...services.publicAccount(account), last_success_at: latest?.published_at || null };
    });
  });

  // Start OAuth for a new account on this platform, or store a pasted token as an account.
  app.post("/api/social/:platform/connect", async (request) => {
    const platform = String(request.params.platform || "").toLowerCase();
    normalizePlatforms([platform]);
    const body = request.body || {};
    if (!body.access_token && !body.account_name) {
      const url = oauth.authorizeUrl(platform, config, oauth.createState(platform, config.appSecret));
      if (!url) {
        throw httpError(
          400,
          "NOT_CONFIGURED",
          "OAuth app credentials are not set. Add the client id and secret, or connect with an access token. See docs/13-oauth-setup.md"
        );
      }
      return { mode: "oauth", authorize_url: url };
    }
    const data = {
      account_name: body.account_name || platform,
      status: "CONNECTED",
      expires_at: body.expires_at || null,
      scopes: body.scopes || [],
      access_token_encrypted: body.access_token
        ? services.sealTokens({ access_token: String(body.access_token), access_expires_at: null, refresh_token: null }, config.appSecret)
        : null,
      external_account_id: body.external_account_id || null,
    };
    const existing = await store.findAccountByExternal(platform, data.external_account_id);
    const saved = existing ? await store.updateAccount(existing.id, data) : await store.createAccount(platform, data);
    return services.publicAccount(saved);
  });

  app.get("/api/social/:platform/callback", async (request, reply) => {
    const platform = String(request.params.platform || "").toLowerCase();
    normalizePlatforms([platform]);
    const back = (error, count) =>
      reply.redirect(
        error
          ? `/?oauth_error=${encodeURIComponent(error)}#accounts`
          : `/?connected=${platform}&count=${count || 1}#accounts`
      );
    if (request.query.error) return back(String(request.query.error_description || request.query.error));
    if (!request.query.code) return back("OAuth callback did not include a code");
    if (!oauth.verifyState(request.query.state, platform, config.appSecret)) {
      return back("OAuth state is invalid or expired. Start the connection again.");
    }
    try {
      const result = await oauth.exchangeCode(platform, String(request.query.code), config);
      // Reconnecting an account we already have updates it instead of adding a duplicate.
      for (const item of result.accounts) {
        const data = {
          account_name: item.account_name,
          external_account_id: item.external_account_id,
          status: "CONNECTED",
          scopes: item.scopes,
          expires_at: item.expires_at,
          access_token_encrypted: services.sealTokens(item.tokens, config.appSecret),
          refresh_token_encrypted: null,
        };
        const existing = await store.findAccountByExternal(platform, item.external_account_id);
        if (existing) await store.updateAccount(existing.id, data);
        else await store.createAccount(platform, data);
      }
      await store.addLog({
        level: "INFO",
        job: "oauth",
        platform,
        request_id: randomUUID(),
        message: `${platform} connected: ${result.accounts.map((item) => item.account_name).join(", ")}`,
      });
      return back(null, result.accounts.length);
    } catch (error) {
      await store.addLog({ level: "ERROR", job: "oauth", platform, request_id: randomUUID(), message: error.message });
      return back(error.message);
    }
  });

  async function accountOr404(id) {
    const account = await store.getAccountById(id);
    if (!account) throw httpError(404, "NOT_FOUND", "Account not found");
    return account;
  }

  async function testAccount(account) {
    const { publishDecision } = require("./providers");
    let outcome = publishDecision(account, "mock");
    if (config.publisherMode === "live" && account?.status === "CONNECTED") {
      try {
        const token = await services.liveToken(store, account, config);
        const who = await verifyAccount(account.platform, { token, account, config });
        outcome = { ok: true, name: who.name };
      } catch (error) {
        if (error.code === "OAUTH_EXPIRED") await store.updateAccount(account.id, { status: "EXPIRED" });
        outcome = { ok: false, code: error.code || "UPSTREAM", message: error.message };
      }
    }
    const platform = account?.platform || null;
    await store.addLog({
      level: outcome.ok ? "INFO" : "WARNING",
      job: "social-test",
      platform,
      request_id: randomUUID(),
      message: outcome.ok
        ? `${platform} connection ok${outcome.name ? ` (${outcome.name})` : account?.account_name ? ` (${account.account_name})` : ""}`
        : `${account?.account_name ? `${account.account_name}: ` : ""}${outcome.message}`,
    });
    if (!outcome.ok) throw httpError(409, outcome.code, outcome.message);
    return { status: "ok", platform, account_id: account.id };
  }

  async function disconnectAccount(account) {
    const sealed = await store.getAccountSecret(account.id);
    if (sealed) {
      let tokens = null;
      try {
        tokens = services.readTokens(sealed, config.appSecret);
      } catch {
        tokens = null;
      }
      const result = await compliance.revokeTokens(account.platform, tokens, config);
      await store.addLog({
        level: "INFO",
        job: "oauth",
        platform: account.platform,
        request_id: randomUUID(),
        message: `${account.account_name || account.platform} disconnected; platform revoke: ${result.revoked ? "done" : result.reason || `HTTP ${result.status}`}`,
      });
    }
    return services.publicAccount(
      await store.updateAccount(account.id, {
        status: "DISCONNECTED",
        access_token_encrypted: null,
        refresh_token_encrypted: null,
      })
    );
  }

  app.get("/api/social/accounts/:id/tiktok-creator", async (request) => {
    const account = await accountOr404(request.params.id);
    if (account.platform !== "tiktok") throw httpError(400, "VALIDATION", "Not a TikTok account");
    if (config.publisherMode !== "live") {
      // Mock mode has no TikTok session; show the same shape so the dialog can be exercised.
      return {
        mock: true,
        creator_nickname: account.account_name,
        creator_username: account.account_name,
        privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
        comment_disabled: false,
        duet_disabled: false,
        stitch_disabled: false,
        max_video_post_duration_sec: 600,
      };
    }
    if (account.status !== "CONNECTED") throw httpError(409, "NOT_CONNECTED", "Account is not connected");
    const token = await services.liveToken(store, account, config);
    return tiktokCreatorInfo(token);
  });

  app.post("/api/social/accounts/:id/test", async (request) => testAccount(await accountOr404(request.params.id)));

  app.post("/api/social/accounts/:id/disconnect", async (request) =>
    disconnectAccount(await accountOr404(request.params.id))
  );

  app.post("/api/social/accounts/:id/default", async (request) => {
    await accountOr404(request.params.id);
    return services.publicAccount(await store.setDefaultAccount(request.params.id));
  });

  app.patch("/api/social/accounts/:id", async (request) => {
    await accountOr404(request.params.id);
    const name = String(request.body?.account_name || "").trim();
    if (!name) throw httpError(400, "VALIDATION", "account_name is required");
    return services.publicAccount(await store.updateAccount(request.params.id, { account_name: name }));
  });

  app.delete("/api/social/accounts/:id", async (request, reply) => {
    const account = await accountOr404(request.params.id);
    if ((await store.countAccountUsage(account.id)) > 0) {
      throw httpError(
        409,
        "IN_USE",
        "This account has scheduled or published posts. Disconnect it instead so the post history is kept."
      );
    }
    // Drop it from content and automation selections before deleting.
    for (const row of await store.listContent()) {
      if ((row.account_ids || []).includes(account.id)) {
        await store.updateContent(row.id, { account_ids: row.account_ids.filter((id) => id !== account.id) });
      }
    }
    const automation = await store.getAutomation();
    if ((automation.account_ids || []).includes(account.id)) {
      await store.saveAutomation({ account_ids: automation.account_ids.filter((id) => id !== account.id) });
    }
    await disconnectAccount(account);
    await store.deleteAccount(account.id);
    reply.code(204);
    return null;
  });

  // Platform-level routes act on the platform's default account (kept for older clients).
  app.post("/api/social/:platform/test", async (request) => {
    const platform = String(request.params.platform || "").toLowerCase();
    normalizePlatforms([platform]);
    const account = await store.getDefaultAccount(platform);
    if (!account) throw httpError(409, "NOT_CONNECTED", "Account is not connected");
    return testAccount(account);
  });

  app.post("/api/social/:platform/disconnect", async (request) => {
    const platform = String(request.params.platform || "").toLowerCase();
    normalizePlatforms([platform]);
    const account = await store.getDefaultAccount(platform);
    if (!account) throw httpError(404, "NOT_FOUND", "Account not found");
    return disconnectAccount(account);
  });

  app.post("/api/meta/data-deletion", async (request, reply) => {
    const data = compliance.parseSignedRequest(request.body?.signed_request, config.metaAppSecret);
    if (!data?.user_id) throw httpError(400, "VALIDATION", "Invalid signed_request");
    const { code } = await services.handleMetaDeletion(store, data.user_id, config, "data deletion");
    reply.type("application/json");
    return { url: `${String(config.publicUrl || "").replace(/\/$/, "")}/data-deletion?code=${code}`, confirmation_code: code };
  });

  app.post("/api/meta/deauthorize", async (request) => {
    const data = compliance.parseSignedRequest(request.body?.signed_request, config.metaAppSecret);
    if (!data?.user_id) throw httpError(400, "VALIDATION", "Invalid signed_request");
    await services.handleMetaDeletion(store, data.user_id, config, "deauthorize");
    return { status: "ok" };
  });

  app.get("/privacy", async (_request, reply) => reply.type("text/html; charset=utf-8").send(legal.privacyPage(legalConfig)));
  app.get("/terms", async (_request, reply) => reply.type("text/html; charset=utf-8").send(legal.termsPage(legalConfig)));
  app.get("/data-deletion", async (request, reply) => {
    const code = String(request.query.code || "").trim().slice(0, 40);
    const found = code ? await store.getDeletionRequest(code) : null;
    const shown = found || (code ? { confirmation_code: code, status: "NOT_FOUND", detail: "No request with this code. Check the code or contact us.", accounts_affected: 0 } : null);
    return reply.type("text/html; charset=utf-8").send(legal.deletionPage(legalConfig, shown));
  });

  app.get("/api/media/:assetId", async (request, reply) => {
    const asset = (await store.listAssets()).find((row) => row.id === request.params.assetId);
    if (!asset?.storage_path || !fs.existsSync(asset.storage_path)) throw httpError(404, "NOT_FOUND", "Media not found");
    const size = fs.statSync(asset.storage_path).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range || ""));
    reply.header("accept-ranges", "bytes").type(asset.mime_type || "video/mp4");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        reply.code(416).header("content-range", `bytes */${size}`);
        return reply.send();
      }
      reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1);
      return reply.send(fs.createReadStream(asset.storage_path, { start, end }));
    }
    reply.header("content-length", size);
    return reply.send(fs.createReadStream(asset.storage_path));
  });

  app.get("/api/automation/settings", async () => store.getAutomation());

  app.patch("/api/automation/settings", async (request) => {
    const body = request.body || {};
    if (body.platforms) body.platforms = normalizePlatforms(body.platforms);
    if (body.account_ids !== undefined || body.platforms) {
      const current = await store.getAutomation();
      body.account_ids = await services.cleanAccountIds(
        store,
        body.account_ids ?? current.account_ids ?? [],
        body.platforms || current.platforms || PLATFORMS
      );
    }
    if (body.max_concurrent_jobs != null && Number(body.max_concurrent_jobs) !== 1) {
      throw httpError(400, "VALIDATION", "max_concurrent_jobs must stay at 1 on this server");
    }
    return store.saveAutomation(body);
  });

  app.post("/api/automation/run-now", async () =>
    services.runAutomation(store, {
      publisherMode: config.publisherMode,
      ai: await services.currentAi(store, config),
      video: config.video,
      config,
    })
  );

  app.get("/api/jobs", async () => store.listJobs());

  app.get("/api/jobs/:id", async (request) => {
    const job = await store.getJob(request.params.id);
    if (!job) throw httpError(404, "NOT_FOUND", "Job not found");
    return job;
  });

  app.post("/api/jobs/:id/retry", async (request) => {
    const job = await store.getJob(request.params.id);
    if (!job) throw httpError(404, "NOT_FOUND", "Job not found");
    if (job.job_type === "video") {
      return services.renderVideo(store, job.content_id, config.video);
    }
    throw httpError(400, "VALIDATION", "This job type cannot be retried here");
  });

  app.get("/api/logs", async (request) => {
    const logs = await store.listLogs();
    const content = await store.listContent();
    return logs
      .filter((row) => !request.query.level || row.level === request.query.level)
      .filter((row) => !request.query.job || row.job === request.query.job)
      .filter((row) => !request.query.platform || row.platform === request.query.platform)
      .filter((row) => !request.query.content || row.content_id === request.query.content)
      .filter((row) => !request.query.request_id || String(row.request_id || "").includes(request.query.request_id))
      .filter((row) => {
        if (!request.query.date) return true;
        return tzDateKey(new Date(row.created_at), "Asia/Bangkok") === request.query.date;
      })
      .map((row) => ({
        ...row,
        public_no: content.find((item) => item.id === row.content_id)?.public_no || null,
      }));
  });

  app.get("/api/analytics", async () => services.analyticsSummary(store));

  app.get("/api/settings", async () => maskSettings(await store.getSettings(), config));

  app.patch("/api/settings/:section", async (request) => {
    const section = request.params.section;
    if (!SETTINGS_SECTIONS.includes(section)) throw httpError(404, "NOT_FOUND", "Unknown settings section");
    const patch = { ...(request.body || {}) };
    if (section === "ai") {
      if (patch.provider && !AI_PRESETS[patch.provider]) {
        throw httpError(400, "VALIDATION", `provider must be one of: ${Object.keys(AI_PRESETS).join(", ")}`);
      }
      const apiKey = patch.api_key;
      // Server-owned and display-only fields never come from the dashboard.
      for (const key of ["api_key", "providers", "base_url", "api_key_set", "api_key_hint", "api_key_provider", "api_key_encrypted"]) {
        delete patch[key];
      }
      if (apiKey) {
        const current = await store.getSettings();
        patch.api_key_encrypted = services.encryptSecret(apiKey, config.appSecret);
        patch.api_key_provider = patch.provider || current.ai?.provider || config.ai?.provider;
        patch.api_key_set = true;
      }
    }
    delete patch.api_key_encrypted_plain;
    const saved = await store.saveSettings(section, patch);
    return maskSettings(saved, config);
  });

  app.post("/api/settings/ai/test", async () => testAi(await services.currentAi(store, config)));

  const dist = config.staticDir;
  if (dist && fs.existsSync(path.join(dist, "index.html"))) {
    app.get("/*", async (request, reply) => {
      if (request.url.startsWith("/api/")) throw httpError(404, "NOT_FOUND", "Not found");
      const requested = path.normalize(path.join(dist, request.url.split("?")[0]));
      const file = requested.startsWith(dist) && fs.existsSync(requested) && fs.statSync(requested).isFile()
        ? requested
        : path.join(dist, "index.html");
      const ext = path.extname(file);
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
      reply.type(types[ext] || "application/octet-stream");
      return reply.send(fs.readFileSync(file));
    });
  }

  return app;
}

async function loadContentView(store, id) {
  const content = await store.getContent(id);
  if (!content) return null;
  const [assets, scheduled, posts, accounts] = await Promise.all([
    store.listAssets(id),
    store.listScheduled(),
    store.listPosts(),
    store.listAccounts(),
  ]);
  return services.contentView(content, assets, scheduled, posts, accounts);
}

function readCookie(request, name) {
  const raw = request.headers.cookie || "";
  const found = raw.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : "";
}

function cookieHeader(token, config) {
  const secure = config.nodeEnv === "production" ? "; Secure" : "";
  return `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${secure}`;
}

function limit(hits, ip, bucket, max) {
  const key = `${ip}:${bucket}`;
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((time) => now - time < 60_000);
  if (recent.length >= max) throw httpError(429, "RATE_LIMIT", "Too many requests");
  recent.push(now);
  hits.set(key, recent);
}

function maskSettings(settings, config) {
  const ai = { ...(settings.ai || {}) };
  delete ai.api_key_encrypted;
  delete ai.api_key;
  const active = resolveAi(config, settings.ai || {});
  ai.provider = active.provider;
  ai.model = active.model;
  ai.base_url = active.baseUrl;
  ai.providers = Object.entries(AI_PRESETS).map(([id, preset]) => ({ id, label: preset.label, model: preset.model, needs_key: preset.needsKey }));
  ai.api_key_set = Boolean(
    (active.provider === config.ai?.provider && config.ai?.apiKey) ||
      (settings.ai?.api_key_set && settings.ai?.api_key_provider === active.provider)
  );
  ai.api_key_hint = ai.api_key_set ? "configured" : "";
  return { ...settings, ai };
}

module.exports = { buildApp };
