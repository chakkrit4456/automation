const { randomUUID, createCipheriv, createDecipheriv, scryptSync, randomBytes } = require("crypto");
const {
  httpError,
  isDuplicate,
  aggregatePublishStatus,
  contentStatusFromPosts,
  idempotentPublishDecision,
  shouldAutoRetry,
  isPermanentError,
  validateMedia,
  tzDateKey,
  nextPublishInstant,
  shouldGenerateAhead,
  PLATFORMS,
} = require("./domain");
const { generateConcepts, generateVideo, publishDecision, resolveAi } = require("./providers");
const { publishLive } = require("./publishers");
const { refreshTokens } = require("./oauth");
const compliance = require("./compliance");

function encryptSecret(plain, secret) {
  if (!plain) return null;
  const iv = randomBytes(12);
  const key = scryptSync(secret, "ai-social-token", 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptSecret(payload, secret) {
  if (!payload || payload === "[encrypted]") return null;
  const buffer = Buffer.from(payload, "base64");
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const data = buffer.subarray(28);
  const key = scryptSync(secret, "ai-social-token", 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// The free AI model to call right now: .env defaults, overridden by the dashboard AI settings.
// A key saved from the dashboard is only used for the provider it was saved for.
async function currentAi(store, config) {
  const ai = (await store.getSettings()).ai || {};
  const provider = ai.provider || config?.ai?.provider;
  let savedKey = "";
  if (ai.api_key_encrypted && ai.api_key_provider === provider) {
    try {
      savedKey = decryptSecret(ai.api_key_encrypted, config.appSecret) || "";
    } catch {
      savedKey = "";
    }
  }
  return resolveAi(config, ai, savedKey);
}

function publicAccount(account) {
  if (!account) return null;
  return {
    id: account.id,
    platform: account.platform,
    account_name: account.account_name,
    external_account_id: account.external_account_id,
    expires_at: account.expires_at,
    scopes: account.scopes || [],
    status: account.status,
    is_default: Boolean(account.is_default),
    has_token: Boolean(account.has_token || account.access_token_encrypted),
    created_at: account.created_at,
    updated_at: account.updated_at,
  };
}

// Which accounts a content item goes to on each platform: the accounts chosen on the
// content, or the platform's default account when none were chosen for that platform.
function resolveTargets(content, accounts, platforms) {
  const chosen = new Set(content.account_ids || []);
  const targets = [];
  for (const platform of platforms) {
    const mine = accounts.filter((row) => row.platform === platform);
    const picked = mine.filter((row) => chosen.has(row.id));
    if (picked.length) {
      for (const account of picked) targets.push({ platform, account });
    } else {
      targets.push({ platform, account: mine.find((row) => row.is_default) || mine[0] || null });
    }
  }
  return targets;
}

// The queue row for one target. Rows created before accounts were per-row have no
// account_id; such a row is reused for the target on its platform.
function findScheduled(rows, contentId, platform, accountId) {
  const mine = rows.filter((row) => row.content_id === contentId && row.platform === platform);
  return (
    mine.find((row) => (row.account_id || null) === (accountId || null)) ||
    mine.find((row) => !row.account_id) ||
    null
  );
}

function contentView(content, assets, scheduled, posts, accounts = []) {
  const mineScheduled = scheduled.filter((row) => row.content_id === content.id);
  const entries = [];
  for (const platform of PLATFORMS) {
    if (!content.platforms?.includes(platform)) {
      entries.push({ platform, status: "NOT_SELECTED" });
      continue;
    }
    const targets = resolveTargets(content, accounts, [platform]).map((row) => row.account);
    // Also show queue rows for accounts that are no longer selected, so history stays visible.
    for (const row of mineScheduled.filter((item) => item.platform === platform && item.account_id)) {
      if (!targets.some((account) => account?.id === row.account_id)) {
        targets.push(accounts.find((account) => account.id === row.account_id) || { id: row.account_id, platform });
      }
    }
    for (const account of targets) {
      const scheduledRow = findScheduled(mineScheduled, content.id, platform, account?.id || null);
      const post = scheduledRow ? posts.find((row) => row.scheduled_post_id === scheduledRow.id) : null;
      entries.push({
        platform,
        account_id: account?.id || null,
        account_name: account?.account_name || null,
        status: scheduledRow?.status === "CANCELLED" && !post ? "CANCELLED" : post?.status || scheduledRow?.status || "NONE",
        attempts: post?.attempts || 0,
        error_code: post?.last_error_code || null,
        error_message: post?.last_error_message || null,
        external_post_id: post?.external_post_id || null,
        published_at: post?.published_at || null,
        scheduled_at: scheduledRow?.scheduled_at || content.scheduled_at || null,
      });
    }
  }
  return {
    ...content,
    account_ids: content.account_ids || [],
    assets: assets.filter((row) => row.content_id === content.id),
    publishing: entries,
  };
}

// Keep only known account ids whose platform is one of the content's platforms.
async function cleanAccountIds(store, ids, platforms) {
  if (ids == null) return undefined;
  if (!Array.isArray(ids)) throw httpError(400, "VALIDATION", "account_ids must be an array");
  const accounts = await store.listAccounts();
  const unique = [...new Set(ids.map(String))];
  const unknown = unique.filter((id) => !accounts.some((row) => row.id === id));
  if (unknown.length) throw httpError(400, "VALIDATION", `Unknown account: ${unknown.join(", ")}`);
  return unique.filter((id) => platforms.includes(accounts.find((row) => row.id === id).platform));
}

async function bundle(store) {
  const [content, assets, scheduled, posts, accounts, logs, jobs, automation] = await Promise.all([
    store.listContent(),
    store.listAssets(),
    store.listScheduled(),
    store.listPosts(),
    store.listAccounts(),
    store.listLogs(),
    store.listJobs(),
    store.getAutomation(),
  ]);
  return { content, assets, scheduled, posts, accounts, logs, jobs, automation };
}

async function createContent(store, input) {
  const rows = await store.listContent();
  if (isDuplicate(rows, input.topic, input.hook)) {
    throw httpError(409, "DUPLICATE", "A content item with the same topic and hook already exists");
  }
  const accountIds = (await cleanAccountIds(store, input.account_ids, input.platforms || PLATFORMS)) || [];
  return store.createContent({ ...input, account_ids: accountIds });
}

async function generateAndOptionallySave(store, input, options) {
  const rows = await store.listContent();
  const generated = await generateConcepts(input, {
    ai: options.ai,
    recent: rows.map((row) => ({ topic: row.topic, hook: row.hook })),
  });
  const fresh = generated.concepts.filter((concept) => !isDuplicate(rows, concept.topic, concept.hook));
  if (!fresh.length) {
    throw httpError(409, "DUPLICATE", "Generated concepts repeat an existing topic and hook");
  }
  if (!options.save) {
    return { provider: generated.provider, concepts: fresh };
  }
  const saved = [];
  for (const concept of fresh) {
    const when = options.queue ? options.scheduledAt : null;
    const row = await store.createContent({
      ...concept,
      niche: input.niche,
      language: input.language,
      tone: input.tone,
      style: input.style,
      duration_seconds: input.duration_seconds,
      target_audience: input.target_audience,
      platforms: input.platforms,
      account_ids: (await cleanAccountIds(store, input.account_ids || [], input.platforms)) || [],
      status: options.queue ? "SCHEDULED" : "DRAFT",
      scheduled_at: when,
    });
    if (options.queue && when) {
      await scheduleContent(store, row.id, { scheduled_at: when, platforms: input.platforms });
    }
    saved.push(row);
    await store.addLog({
      level: "INFO",
      job: "ai",
      content_id: row.id,
      request_id: randomUUID(),
      message: `${generated.provider} created concept #${row.public_no}`,
    });
  }
  return { provider: generated.provider, concepts: fresh, saved };
}

async function scheduleContent(store, contentId, input) {
  const content = await store.getContent(contentId);
  if (!content) throw httpError(404, "NOT_FOUND", "Content not found");
  if (content.status === "CANCELLED") throw httpError(409, "CANCELLED", "Cancelled content cannot be scheduled");
  const scheduledAt = input.scheduled_at;
  if (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime())) {
    throw httpError(400, "VALIDATION", "scheduled_at must be an ISO datetime");
  }
  const platforms = input.platforms;
  const accountIds = await cleanAccountIds(store, input.account_ids, platforms);
  const nextAccounts = accountIds ?? (await cleanAccountIds(store, content.account_ids || [], platforms));
  const reapprove = compliance.approvalInvalidated(content, { platforms, account_ids: nextAccounts });
  const updated = await store.updateContent(contentId, {
    scheduled_at: scheduledAt,
    platforms,
    account_ids: nextAccounts,
    ...(reapprove ? { approved_at: null, approved_by: null } : {}),
    status: content.status === "PUBLISHED" || content.status === "PARTIAL" ? content.status : "SCHEDULED",
  });
  const accounts = await store.listAccounts();
  const targets = resolveTargets(updated, accounts, platforms);
  const kept = new Set();
  for (const { platform, account } of targets) {
    const accountId = account?.id || null;
    let existing = findScheduled(await store.listScheduled(), contentId, platform, accountId);
    if (existing && !existing.account_id && accountId) {
      existing = await store.assignScheduledAccount(existing.id, accountId);
    }
    const posts = await store.listPosts();
    const post = existing ? posts.find((row) => row.scheduled_post_id === existing.id) : null;
    const scheduled = await store.upsertScheduled({
      content_id: contentId,
      platform,
      account_id: accountId,
      scheduled_at: scheduledAt,
      // Never re-queue something that is already live on that account.
      status: post?.status === "SUCCESS" ? "PUBLISHED" : "SCHEDULED",
    });
    kept.add(scheduled.id);
    if (!post) {
      await store.savePost({ scheduled_post_id: scheduled.id, platform, status: "QUEUED", attempts: 0 });
    }
  }
  // Destinations that were removed from this content stop being published.
  for (const row of (await store.listScheduled()).filter((item) => item.content_id === contentId)) {
    if (!kept.has(row.id) && row.status === "SCHEDULED") {
      await store.upsertScheduled({ ...row, status: "CANCELLED" });
    }
  }
  await store.addLog({
    level: "INFO",
    job: "scheduler",
    content_id: contentId,
    message: `Scheduled #${content.public_no} at ${scheduledAt} to ${targets.length} account(s)`,
  });
  return store.getContent(contentId);
}

async function renderVideo(store, contentId, options) {
  const content = await store.getContent(contentId);
  if (!content) throw httpError(404, "NOT_FOUND", "Content not found");
  const running = (await store.listJobs()).filter(
    (job) => job.job_type === "video" && (job.status === "RUNNING" || job.status === "QUEUED")
  );
  if (running.length >= 1) {
    throw httpError(429, "BUSY", "One video job is already running");
  }
  const job = await store.createJob({
    content_id: contentId,
    job_type: "video",
    provider: "ffmpeg",
    status: "RUNNING",
    attempt: 1,
    started_at: new Date().toISOString(),
  });
  await store.updateContent(contentId, { status: content.status === "DRAFT" ? "PROCESSING" : content.status });
  try {
    const rendered = await generateVideo(content, options);
    const issues = validateMedia(
      { ...rendered, provider: rendered.provider },
      { maxMb: options.maxMb || 500 }
    );
    if (issues.length && rendered.provider !== "mock") {
      throw httpError(422, "MEDIA_INVALID", issues.join("; "));
    }
    const asset = await store.createAsset({
      content_id: contentId,
      type: "video",
      ...rendered,
    });
    if (content.approved_at) {
      await store.updateContent(contentId, { approved_at: null, approved_by: null });
    }
    await store.updateJob(job.id, {
      status: "SUCCEEDED",
      provider: rendered.provider,
      completed_at: new Date().toISOString(),
    });
    if (content.status === "PROCESSING" || content.status === "DRAFT" || content.status === "GENERATING") {
      await store.updateContent(contentId, { status: "READY" });
    }
    await store.addLog({
      level: "INFO",
      job: "ffmpeg",
      content_id: contentId,
      request_id: job.id,
      message: `Render ${rendered.provider} #${content.public_no} ${rendered.width}x${rendered.height}`,
    });
    return { job_id: job.id, asset, media_warnings: rendered.provider === "mock" ? issues : [] };
  } catch (error) {
    await store.updateJob(job.id, {
      status: "FAILED",
      error_code: error.code || "VIDEO_FAILED",
      error_message: error.message,
      completed_at: new Date().toISOString(),
    });
    await store.addLog({
      level: "ERROR",
      job: "ffmpeg",
      content_id: contentId,
      request_id: job.id,
      message: error.message,
    });
    throw error;
  }
}

function readTokens(sealed, secret) {
  const plain = decryptSecret(sealed, secret);
  if (!plain) return null;
  try {
    const parsed = JSON.parse(plain);
    if (parsed && typeof parsed === "object" && parsed.access_token) return parsed;
  } catch {
    // Tokens pasted by hand are stored as the raw string.
  }
  return { access_token: plain, access_expires_at: null, refresh_token: null };
}

function sealTokens(tokens, secret) {
  return encryptSecret(JSON.stringify(tokens), secret);
}

async function liveToken(store, account, config, deps = {}) {
  const platform = account.platform;
  const sealed = await store.getAccountSecret(account.id);
  const tokens = sealed ? readTokens(sealed, config.appSecret) : null;
  if (!tokens?.access_token) throw httpError(409, "NOT_CONNECTED", "Account has no access token. Connect it again.");
  const expiresAt = tokens.access_expires_at ? new Date(tokens.access_expires_at).getTime() : null;
  if (expiresAt && expiresAt - Date.now() < 2 * 60_000) {
    const refreshed = await (deps.refreshTokens || refreshTokens)(platform, tokens, config, deps.fetchImpl);
    await store.updateAccount(account.id, { access_token_encrypted: sealTokens(refreshed, config.appSecret) });
    return refreshed.access_token;
  }
  return tokens.access_token;
}

async function latestVideo(store, contentId) {
  const assets = await store.listAssets(contentId);
  return (
    assets
      .filter((row) => row.type === "video" && row.status === "READY" && row.storage_path)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null
  );
}

async function attemptPublish(store, platform, account, content, options) {
  if (options.publisherMode !== "live") return publishDecision(account, "mock");
  if (!account || account.status !== "CONNECTED") {
    return { ok: false, code: "NOT_CONNECTED", message: "Account is not connected", permanent: true };
  }
  try {
    const config = options.config || {};
    const video = await latestVideo(store, content.id);
    if (!video) {
      return { ok: false, code: "MEDIA_MISSING", message: "No rendered MP4 for this content. Render the video first." };
    }
    const token = await liveToken(store, account, config, options.deps);
    const publish = options.deps?.publishLive || publishLive;
    const result = await publish(platform, {
      token,
      account,
      content,
      video: { path: video.storage_path, size: video.file_size, duration: Number(video.duration_seconds || 0) },
      config,
    });
    return { ok: true, external_id: result.external_id, note: result.note || null };
  } catch (error) {
    if (error.code === "OAUTH_EXPIRED") {
      await store.updateAccount(account.id, { status: "EXPIRED" });
    }
    return { ok: false, code: error.code || "UPSTREAM", message: error.message };
  }
}

async function publishContent(store, contentId, options) {
  if (options.idempotencyKey) {
    const hit = await store.getIdempotency(options.idempotencyKey);
    if (hit) return hit.response;
  }
  const content = await store.getContent(contentId);
  if (!content) throw httpError(404, "NOT_FOUND", "Content not found");
  if (content.status === "CANCELLED") throw httpError(409, "CANCELLED", "Cancelled content cannot be published");
  if (options.publisherMode === "live" && !content.approved_at) {
    // YouTube, TikTok and Meta all require the user's express consent to each upload.
    return { content_id: contentId, status: "WAITING_APPROVAL", platforms: [] };
  }
  const platforms = options.platforms || content.platforms || PLATFORMS;
  const accounts = await store.listAccounts();
  const automation = await store.getAutomation();
  const results = [];
  let targets = resolveTargets(content, accounts, platforms);
  if (options.targets) {
    // Explicit queue rows (scheduler) or one account (retry button).
    targets = options.targets.map((target) => ({
      platform: target.platform,
      account: target.account_id
        ? accounts.find((row) => row.id === target.account_id) || null
        : resolveTargets(content, accounts, [target.platform])[0].account,
    }));
  }

  for (const { platform, account } of targets) {
    const accountId = account?.id || null;
    const label = { platform, account_id: accountId, account_name: account?.account_name || null };
    // Phase 1: decide whether to attempt, inside a short transaction.
    const prep = await store.transaction(async (tx) => {
      let scheduled = findScheduled(await tx.listScheduled(), contentId, platform, accountId);
      if (scheduled && !scheduled.account_id && accountId) {
        scheduled = await tx.assignScheduledAccount(scheduled.id, accountId);
      }
      if (!scheduled) {
        scheduled = await tx.upsertScheduled({
          content_id: contentId,
          platform,
          account_id: accountId,
          scheduled_at: content.scheduled_at || new Date().toISOString(),
          status: "SCHEDULED",
        });
      }
      const post = (await tx.listPosts()).find(
        (row) => row.scheduled_post_id === scheduled.id && row.platform === platform
      );
      const decision = idempotentPublishDecision(post);
      if (decision.action === "skip") {
        return {
          result: {
            ...label,
            status: "SUCCESS",
            skipped: true,
            external_post_id: post.external_post_id,
            attempts: post.attempts,
          },
        };
      }
      if (
        post &&
        !options.force &&
        !shouldAutoRetry({
          errorCode: post.last_error_code,
          attempts: post.attempts,
          maxAttempts: automation.retry_count,
        }) &&
        post.status === "FAILED"
      ) {
        return {
          result: {
            ...label,
            status: "FAILED",
            error_code: post.last_error_code,
            error_message: post.last_error_message,
            attempts: post.attempts,
            skipped: true,
          },
        };
      }
      return { scheduled, post };
    });
    if (prep.result) {
      results.push(prep.result);
      continue;
    }

    // Phase 2: the upload itself runs outside any transaction; it can take minutes.
    const outcome = await attemptPublish(store, platform, account, content, options);
    const attempts = (prep.post?.attempts || 0) + 1;
    const requestId = randomUUID();

    // Phase 3: record the outcome.
    await store.transaction(async (tx) => {
      if (outcome.ok) {
        await tx.savePost({
          scheduled_post_id: prep.scheduled.id,
          platform,
          status: "SUCCESS",
          attempts,
          external_post_id: outcome.external_id,
          last_error_code: null,
          last_error_message: null,
          published_at: new Date().toISOString(),
        });
        await tx.upsertScheduled({
          content_id: contentId,
          platform,
          account_id: prep.scheduled.account_id || null,
          scheduled_at: prep.scheduled.scheduled_at,
          status: "PUBLISHED",
        });
        await tx.addLog({
          level: "INFO",
          job: "publish",
          content_id: contentId,
          platform,
          request_id: requestId,
          message: `Published #${content.public_no} on ${platform}${account?.account_name ? ` / ${account.account_name}` : ""}${outcome.note ? ` (${outcome.note})` : ""}`,
        });
      } else {
        await tx.savePost({
          scheduled_post_id: prep.scheduled.id,
          platform,
          status: "FAILED",
          attempts,
          external_post_id: prep.post?.external_post_id || null,
          last_error_code: outcome.code,
          last_error_message: outcome.message,
          published_at: null,
        });
        await tx.addLog({
          level: isPermanentError(outcome.code) ? "ERROR" : "WARNING",
          job: "publish",
          content_id: contentId,
          platform,
          request_id: requestId,
          message: `${account?.account_name ? `${account.account_name}: ` : ""}${outcome.message} (attempt ${attempts}/${automation.retry_count})`,
        });
      }
    });
    results.push(
      outcome.ok
        ? { ...label, status: "SUCCESS", attempts, external_post_id: outcome.external_id, request_id: requestId }
        : {
            ...label,
            status: "FAILED",
            attempts,
            error_code: outcome.code,
            error_message: outcome.message,
            request_id: requestId,
          }
    );
  }

  await store.transaction(async (tx) => {
    const scheduledRows = (await tx.listScheduled()).filter((row) => row.content_id === contentId && row.status !== "CANCELLED");
    const postRows = await tx.listPosts();
    const relevant = scheduledRows
      .map((row) => postRows.find((post) => post.scheduled_post_id === row.id && post.platform === row.platform))
      .filter(Boolean);
    await tx.updateContent(contentId, { status: contentStatusFromPosts(relevant) });
  });

  const response = { content_id: contentId, status: aggregatePublishStatus(results), platforms: results };
  if (options.idempotencyKey) {
    await store.putIdempotency(options.idempotencyKey, `publish:${contentId}`, response);
  }
  return response;
}

// The user has watched the preview, reviewed the text and chosen platform settings.
async function approveContent(store, contentId, input) {
  const content = await store.getContent(contentId);
  if (!content) throw httpError(404, "NOT_FOUND", "Content not found");
  if (content.status === "CANCELLED") throw httpError(409, "CANCELLED", "Cancelled content cannot be approved");
  const edits = {};
  for (const field of ["title", "caption", "hashtags"]) {
    if (input.edits?.[field] !== undefined) edits[field] = input.edits[field];
  }
  if (edits.hashtags && !Array.isArray(edits.hashtags)) throw httpError(400, "VALIDATION", "hashtags must be an array");
  const video = await latestVideo(store, contentId);
  const anyVideo = (await store.listAssets(contentId)).some((row) => row.type === "video" && row.status === "READY");
  if (input.publisherMode === "live" ? !video : !anyVideo) {
    throw httpError(409, "MEDIA_MISSING", "Render the video and watch the preview before approving");
  }
  const platformOptions = { ...(content.platform_options || {}) };
  if ((content.platforms || []).includes("tiktok")) {
    platformOptions.tiktok = compliance.normalizeTiktokOptions(input.platform_options?.tiktok);
  } else {
    delete platformOptions.tiktok;
  }
  const saved = await store.updateContent(contentId, {
    ...edits,
    platform_options: platformOptions,
    approved_at: new Date().toISOString(),
    approved_by: input.user || "admin",
  });
  await store.addLog({
    level: "INFO",
    job: "approval",
    content_id: contentId,
    request_id: randomUUID(),
    message: `#${content.public_no} approved for posting by ${input.user || "admin"}`,
  });
  return saved;
}

// Meta "remove app" / data deletion: forget every token that belongs to that Facebook user.
async function handleMetaDeletion(store, metaUserId, config, kind) {
  const code = compliance.confirmationCode();
  let affected = 0;
  for (const account of await store.listAccounts()) {
    if (account.platform !== "facebook" && account.platform !== "instagram") continue;
    const sealed = await store.getAccountSecret(account.id);
    let tokens = null;
    try {
      tokens = sealed ? readTokens(sealed, config.appSecret) : null;
    } catch {
      tokens = null;
    }
    if (String(tokens?.meta_user_id || "") !== String(metaUserId)) continue;
    await store.updateAccount(account.id, {
      status: "DISCONNECTED",
      access_token_encrypted: null,
      refresh_token_encrypted: null,
    });
    affected += 1;
  }
  const detail =
    kind === "deauthorize"
      ? "App removed in Facebook settings. Access tokens for this user were deleted."
      : "Access tokens and account connections for this Facebook user were deleted. Posts already published on Facebook or Instagram stay there and can be removed in those apps.";
  await store.saveDeletionRequest({
    confirmation_code: code,
    platform: "meta",
    external_user_id: String(metaUserId),
    status: "COMPLETED",
    accounts_affected: affected,
    detail,
    completed_at: new Date().toISOString(),
  });
  await store.addLog({
    level: "INFO",
    job: "data-deletion",
    request_id: code,
    message: `Meta ${kind || "data deletion"} request ${code}: ${affected} account(s) cleared`,
  });
  return { code, affected };
}

async function dashboardSummary(store) {
  const data = await bundle(store);
  const tz = data.automation.timezone || "Asia/Bangkok";
  const today = tzDateKey(new Date(), tz);
  const views = data.content.map((row) => contentView(row, data.assets, data.scheduled, data.posts, data.accounts));
  const scheduled = views.filter((row) => row.status === "SCHEDULED");
  const todayRows = views.filter((row) => row.scheduled_at && tzDateKey(new Date(row.scheduled_at), tz) === today);
  const upcoming = scheduled
    .filter((row) => new Date(row.scheduled_at).getTime() >= Date.now() - 60_000)
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  const connected = data.accounts.filter((row) => row.status === "CONNECTED").length;
  return {
    timezone: tz,
    today,
    counts: {
      videos_today: todayRows.length,
      scheduled: scheduled.length,
      published: views.filter((row) => row.status === "PUBLISHED").length,
      failed: views.filter((row) => row.status === "FAILED" || row.status === "PARTIAL").length,
      awaiting_approval: views.filter((row) => row.status === "SCHEDULED" && !row.approved_at).length,
      generated: views.length,
      connected_accounts: connected,
      account_slots: Math.max(data.accounts.length, 4),
      accounts: data.accounts.length,
    },
    next_scheduled: upcoming[0] || todayRows[0] || null,
    today_preview: todayRows[0] || upcoming[0] || null,
    platforms: PLATFORMS.map((platform) => {
      const mine = data.accounts.filter((row) => row.platform === platform);
      const account = mine.find((row) => row.is_default) || mine[0];
      const latest = data.posts
        .filter((row) => row.platform === platform && row.status === "SUCCESS" && row.published_at)
        .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))[0];
      return {
        platform,
        status: account?.status || "DISCONNECTED",
        account_name: account?.account_name || null,
        expires_at: account?.expires_at || null,
        account_count: mine.length,
        last_success_at: latest?.published_at || null,
      };
    }),
    recent_errors: data.logs.filter((row) => row.level === "ERROR").slice(0, 5),
    recent_activity: data.logs.slice(0, 8),
  };
}

async function analyticsSummary(store) {
  const data = await bundle(store);
  const successes = data.posts.filter((row) => row.status === "SUCCESS").length;
  const failures = data.posts.filter((row) => row.status === "FAILED").length;
  const attempts = successes + failures;
  const videos = (await store.listAssets()).filter((row) => row.type === "video" && row.status === "READY").length;
  return {
    videos_generated: videos,
    videos_published: successes,
    failed_publishes: failures,
    success_rate: attempts ? Math.round((successes / attempts) * 1000) / 10 : null,
    platforms: PLATFORMS.map((platform) => ({
      platform,
      views: null,
      likes: null,
      comments: null,
      shares: null,
      engagement_rate: null,
      note: "Platform APIs have not returned metrics yet",
    })),
    series: [],
  };
}

async function runAutomation(store, options) {
  const settings = await store.getAutomation();
  const now = options.now || new Date();
  await store.addLog({
    level: "INFO",
    job: "scheduler",
    request_id: randomUUID(),
    message: "Automation run started",
  });
  const scheduled = await store.listScheduled();
  const due = scheduled
    .filter((row) => row.status === "SCHEDULED" && new Date(row.scheduled_at).getTime() <= now.getTime())
    .sort((a, b) => new Date(a.scheduled_at) - new Date(b.scheduled_at));
  const contentIds = [...new Set(due.map((row) => row.content_id))].slice(0, settings.max_concurrent_jobs || 1);
  const published = [];
  for (const contentId of contentIds) {
    const assets = await store.listAssets(contentId);
    if (!assets.some((row) => row.type === "video" && row.status === "READY")) {
      await renderVideo(store, contentId, options.video || {});
    }
    published.push(
      await publishContent(store, contentId, {
        publisherMode: options.publisherMode,
        config: options.config,
        targets: due
          .filter((row) => row.content_id === contentId)
          .map((row) => ({ platform: row.platform, account_id: row.account_id || null })),
      })
    );
  }
  let generated = null;
  if (shouldGenerateAhead(settings, now)) {
    const publishAt = nextPublishInstant(settings, now);
    const rows = await store.listContent();
    const slotTaken = rows.some(
      (row) => row.scheduled_at && Math.abs(new Date(row.scheduled_at) - publishAt) < 60_000
    );
    if (!slotTaken) {
      const settingsRow = await store.getSettings();
      generated = await generateAndOptionallySave(
        store,
        {
          topic: settingsRow.general?.daily_topic || "ไอเดียประจำวัน",
          niche: settingsRow.general?.niche || "",
          language: settingsRow.ai?.default_language || "th",
          duration_seconds: 45,
          tone: settingsRow.ai?.default_tone || "friendly",
          count: 1,
          platforms: settings.platforms,
          account_ids: settings.account_ids || [],
        },
        {
          ai: options.ai || (await currentAi(store, options.config)),
          save: true,
          queue: true,
          scheduledAt: publishAt.toISOString(),
        }
      );
    }
  }
  return { published, generated };
}

async function seedDemo(store) {
  const existing = await store.listContent();
  if (existing.length) return false;
  const samples = [
    {
      public_no: 104,
      topic: "อาหารเช้า 5 นาที",
      hook: "ไม่มีเวลาเช้า? ทำได้ใน 5 นาที",
      script: "1. ไข่คน 2. กล้วย 3. โยเกิร์ต",
      caption: "อาหารเช้า 5 นาที",
      hashtags: ["#อาหารเช้า", "#ทำได้จริง"],
      status: "DRAFT",
      scheduled_at: "2026-10-02T09:00:00+07:00",
      platforms: ["tiktok", "instagram", "facebook", "youtube"],
      language: "th",
      tone: "friendly",
      duration_seconds: 45,
      target_audience: "คนทำงาน",
    },
    {
      public_no: 103,
      topic: "เคล็ดลับนอนหลับให้ลึก",
      hook: "ยังไม่หลับตอนตีหนึ่ง ลอง 4 ข้อนี้",
      script: "1. ปิดจอ 2. ห้องมืด 3. เวลาเดิม 4. ไม่คาเฟอีนบ่าย",
      voice_script: "ถ้ายังเพิ่งจะหลับตอนดึก ลองสี่ข้อนี้",
      caption: "นอนหลับให้ลึกขึ้นคืนนี้",
      hashtags: ["#นอนหลับ", "#สุขภาพ"],
      status: "SCHEDULED",
      scheduled_at: "2026-10-01T09:00:00+07:00",
      platforms: ["tiktok", "instagram", "facebook", "youtube"],
      language: "th",
      tone: "calm",
      duration_seconds: 45,
      target_audience: "คนทำงาน",
    },
    {
      public_no: 102,
      topic: "5 วิธีออมเงินสำหรับมนุษย์เงินเดือน",
      hook: "เงินเดือนออกวันเดียวหมด? ลอง 5 ข้อนี้",
      script: "1. แยกบัญชีออมทันทีวันเงินเดือนออก 2. ตั้งเพดานใช้จ่ายรายสัปดาห์ 3. จดค่าใช้จ่าย 3 วัน 4. ตัดของที่ไม่จำเป็น 1 อย่าง 5. ทบทวนทุกสิ้นเดือน",
      voice_script: "ใครเงินเดือนออกแล้วหมดไวยกมือ วันนี้มี 5 วิธี",
      visual_prompt: "flat illustration, office worker, 9:16",
      caption: "ออมง่ายกว่าที่คิด เริ่มวันนี้",
      hashtags: ["#ออมเงิน", "#การเงินส่วนตัว", "#มนุษย์เงินเดือน"],
      title: "5 วิธีออมเงินสำหรับมนุษย์เงินเดือน",
      cta: "กดติดตามเพื่อดูตอนต่อไป",
      status: "PARTIAL",
      scheduled_at: "2026-09-30T09:00:00+07:00",
      platforms: ["tiktok", "instagram", "facebook", "youtube"],
      language: "th",
      tone: "friendly",
      duration_seconds: 45,
      target_audience: "วัยทำงาน",
      niche: "การเงินส่วนตัว",
    },
    {
      public_no: 101,
      topic: "ภาษาอังกฤษวันละประโยค",
      hook: "วันนี้จำประโยคเดียวพอ",
      script: "Could you say that again?",
      caption: "ประโยคเดียวที่ใช้ได้ทุกวัน",
      hashtags: ["#ภาษาอังกฤษ"],
      status: "PUBLISHED",
      scheduled_at: "2026-09-29T09:00:00+07:00",
      platforms: ["tiktok", "instagram", "facebook", "youtube"],
      language: "th",
      duration_seconds: 30,
    },
    {
      public_no: 100,
      topic: "ยืดเหยียดหลังนั่งนาน",
      hook: "นั่งนานแล้วหลังตึง ยืด 30 วินาที",
      script: "1. หมุนไหล่ 2. ยืดอก 3. ยืนยืดน่อง",
      caption: "ยืดหลังระหว่างวัน",
      hashtags: ["#ออฟฟิศ"],
      status: "PUBLISHED",
      scheduled_at: "2026-09-28T09:00:00+07:00",
      platforms: ["tiktok", "instagram", "youtube"],
      language: "th",
      duration_seconds: 30,
    },
  ];

  const created = [];
  for (const sample of samples) {
    const row = await store.createContent(sample);
    created.push(row);
    await store.createAsset({
      content_id: row.id,
      type: "video",
      provider: "mock",
      status: "READY",
      mime_type: "video/mp4",
      width: 1080,
      height: 1920,
      fps: 30,
      duration_seconds: sample.duration_seconds,
      audio_status: "READY",
      subtitle_status: row.topic.includes("อาหารเช้า") ? "PENDING" : "BURNED",
      pipeline: { script: "DONE", tts: "DONE", visuals: "DONE", ffmpeg: "DONE", subtitles: "DONE" },
    });
  }

  const byTopic = Object.fromEntries(created.map((row) => [row.topic, row]));
  const publishPlan = [
    ["5 วิธีออมเงินสำหรับมนุษย์เงินเดือน", "tiktok", "SUCCESS", null, "2026-09-30T08:59:40+07:00"],
    ["5 วิธีออมเงินสำหรับมนุษย์เงินเดือน", "instagram", "SUCCESS", null, "2026-09-30T09:01:02+07:00"],
    ["5 วิธีออมเงินสำหรับมนุษย์เงินเดือน", "facebook", "FAILED", "OAUTH_EXPIRED", null],
    ["5 วิธีออมเงินสำหรับมนุษย์เงินเดือน", "youtube", "SUCCESS", null, "2026-09-30T09:02:18+07:00"],
    ["ภาษาอังกฤษวันละประโยค", "tiktok", "SUCCESS", null, "2026-09-29T09:00:10+07:00"],
    ["ภาษาอังกฤษวันละประโยค", "instagram", "SUCCESS", null, "2026-09-29T09:00:20+07:00"],
    ["ภาษาอังกฤษวันละประโยค", "facebook", "SUCCESS", null, "2026-09-29T09:00:30+07:00"],
    ["ภาษาอังกฤษวันละประโยค", "youtube", "SUCCESS", null, "2026-09-29T09:00:40+07:00"],
    ["ยืดเหยียดหลังนั่งนาน", "tiktok", "SUCCESS", null, "2026-09-28T09:00:10+07:00"],
    ["ยืดเหยียดหลังนั่งนาน", "instagram", "SUCCESS", null, "2026-09-28T09:00:20+07:00"],
    ["ยืดเหยียดหลังนั่งนาน", "youtube", "SUCCESS", null, "2026-09-28T09:00:40+07:00"],
    ["เคล็ดลับนอนหลับให้ลึก", "tiktok", "QUEUED", null, null],
    ["เคล็ดลับนอนหลับให้ลึก", "instagram", "QUEUED", null, null],
    ["เคล็ดลับนอนหลับให้ลึก", "facebook", "QUEUED", null, null],
    ["เคล็ดลับนอนหลับให้ลึก", "youtube", "QUEUED", null, null],
  ];
  for (const [topic, platform, status, error, publishedAt] of publishPlan) {
    const content = byTopic[topic];
    const scheduled = await store.upsertScheduled({
      content_id: content.id,
      platform,
      scheduled_at: content.scheduled_at,
      status: status === "SUCCESS" ? "PUBLISHED" : "SCHEDULED",
    });
    await store.savePost({
      scheduled_post_id: scheduled.id,
      platform,
      status,
      attempts: status === "FAILED" ? 3 : status === "SUCCESS" ? 1 : 0,
      external_post_id: status === "SUCCESS" ? `mock-${platform}-${content.public_no}` : null,
      last_error_code: error,
      last_error_message: error === "OAUTH_EXPIRED" ? "OAuth token expired" : null,
      published_at: publishedAt,
    });
  }

  const accounts = [
    ["tiktok", "@saveeasy.th", "CONNECTED", "2026-11-14T00:00:00+07:00", ["video.publish"]],
    ["instagram", "@saveeasy.th", "CONNECTED", "2026-11-28T00:00:00+07:00", ["content_publish"]],
    ["facebook", "ออมง่าย ทำได้จริง", "TOKEN_EXPIRED", "2026-09-29T00:00:00+07:00", ["pages_manage_posts"]],
    ["youtube", "ออมง่าย Shorts", "CONNECTED", "2027-09-30T00:00:00+07:00", ["youtube.upload"]],
  ];
  for (const [platform, name, status, expires, scopes] of accounts) {
    await store.saveAccount(platform, {
      account_name: name,
      status,
      expires_at: expires,
      scopes,
      access_token_encrypted: status === "DISCONNECTED" ? null : "seed",
    });
  }

  const logRows = [
    ["2026-09-30T09:21:03+07:00", "ERROR", "publish", "5 วิธีออมเงินสำหรับมนุษย์เงินเดือน", "facebook", "OAuth token expired (retry 3/3)"],
    ["2026-09-30T09:02:18+07:00", "INFO", "publish", "5 วิธีออมเงินสำหรับมนุษย์เงินเดือน", "youtube", "Upload complete"],
    ["2026-09-30T09:01:14+07:00", "WARNING", "publish", "5 วิธีออมเงินสำหรับมนุษย์เงินเดือน", "facebook", "401 Unauthorized, scheduling retry"],
    ["2026-09-30T09:01:02+07:00", "INFO", "publish", "5 วิธีออมเงินสำหรับมนุษย์เงินเดือน", "instagram", "Reel published"],
    ["2026-09-30T08:59:40+07:00", "INFO", "publish", "5 วิธีออมเงินสำหรับมนุษย์เงินเดือน", "tiktok", "Video published"],
    ["2026-09-30T06:40:11+07:00", "INFO", "ffmpeg", "เคล็ดลับนอนหลับให้ลึก", null, "Render done 45s 1080x1920"],
    ["2026-09-30T06:12:47+07:00", "DEBUG", "ai", "เคล็ดลับนอนหลับให้ลึก", null, "Mock concept created"],
    ["2026-09-30T06:00:00+07:00", "INFO", "scheduler", null, null, "Daily run started"],
  ];
  for (const [createdAt, level, job, topic, platform, message] of logRows) {
    await store.addLog({
      created_at: createdAt,
      level,
      job,
      content_id: topic ? byTopic[topic].id : null,
      platform,
      request_id: randomUUID(),
      message,
    });
  }
  await store.saveAutomation({
    enabled: true,
    timezone: "Asia/Bangkok",
    daily_quantity: 1,
    publish_time: "09:00",
    generation_lead_hours: 3,
    retry_count: 3,
    retry_backoff_seconds: 600,
    max_concurrent_jobs: 1,
    platforms: ["tiktok", "instagram", "facebook", "youtube"],
  });
  return true;
}

module.exports = {
  currentAi,
  encryptSecret,
  decryptSecret,
  publicAccount,
  contentView,
  bundle,
  createContent,
  generateAndOptionallySave,
  scheduleContent,
  renderVideo,
  publishContent,
  dashboardSummary,
  analyticsSummary,
  runAutomation,
  seedDemo,
  readTokens,
  sealTokens,
  liveToken,
  latestVideo,
  resolveTargets,
  findScheduled,
  cleanAccountIds,
  approveContent,
  handleMetaDeletion,
};
