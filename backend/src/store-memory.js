const { randomUUID, createHash, scryptSync, randomBytes, timingSafeEqual } = require("crypto");

function clone(value) {
  return structuredClone(value);
}

function nowIso() {
  return new Date().toISOString();
}

function defaultAutomation() {
  return {
    id: randomUUID(),
    enabled: false,
    timezone: "Asia/Bangkok",
    daily_quantity: 1,
    publish_time: "09:00",
    generation_lead_days: 3,
    generation_lead_hours: 3,
    max_concurrent_jobs: 1,
    retry_count: 3,
    retry_backoff_seconds: 600,
    platforms: ["tiktok", "instagram", "facebook", "youtube"],
    account_ids: [],
  };
}

function defaultSettings() {
  return {
    general: { app_name: "SOCIAL / AUTO", timezone: "Asia/Bangkok", ui_language: "th" },
    ai: { default_language: "th", default_tone: "friendly", api_key_set: false },
    video: { width: 1080, height: 1920, fps: 30, subtitle_mode: "burn-in" },
    storage: { media_root: "/data/media", max_video_size_mb: 500 },
    social: {},
    security: { token_encryption: true },
    notifications: { email_on_error: false, daily_digest_time: "21:00" },
  };
}

class MemoryStore {
  constructor() {
    this.content = [];
    this.assets = [];
    this.jobs = [];
    this.accounts = [];
    this.scheduled = [];
    this.posts = [];
    this.logs = [];
    this.audit = [];
    this.automation = defaultAutomation();
    this.settings = defaultSettings();
    this.idempotency = new Map();
    this.users = [];
    this.sessions = [];
    this.publicNo = 99;
    this.deletions = [];
  }

  snapshot() {
    return {
      content: clone(this.content),
      assets: clone(this.assets),
      jobs: clone(this.jobs),
      accounts: clone(this.accounts),
      scheduled: clone(this.scheduled),
      posts: clone(this.posts),
      logs: clone(this.logs),
      audit: clone(this.audit),
      automation: clone(this.automation),
      settings: clone(this.settings),
      idempotency: clone([...this.idempotency.entries()]),
      users: clone(this.users),
      sessions: clone(this.sessions),
      publicNo: this.publicNo,
    };
  }

  restore(snap) {
    this.content = snap.content;
    this.assets = snap.assets;
    this.jobs = snap.jobs;
    this.accounts = snap.accounts;
    this.scheduled = snap.scheduled;
    this.posts = snap.posts;
    this.logs = snap.logs;
    this.audit = snap.audit;
    this.automation = snap.automation;
    this.settings = snap.settings;
    this.idempotency = new Map(snap.idempotency);
    this.users = snap.users;
    this.sessions = snap.sessions;
    this.publicNo = snap.publicNo;
  }

  async transaction(fn) {
    const snap = this.snapshot();
    try {
      return await fn(this);
    } catch (error) {
      this.restore(snap);
      throw error;
    }
  }

  async listContent() {
    return clone(this.content).sort((a, b) => b.public_no - a.public_no);
  }

  async getContent(id) {
    return clone(this.content.find((row) => row.id === id) || null);
  }

  async createContent(data) {
    const row = {
      id: randomUUID(),
      public_no: data.public_no || ++this.publicNo,
      topic: data.topic,
      niche: data.niche || null,
      language: data.language || "th",
      tone: data.tone || null,
      duration_seconds: data.duration_seconds ?? 45,
      hook: data.hook || null,
      script: data.script || null,
      voice_script: data.voice_script || null,
      visual_prompt: data.visual_prompt || null,
      caption: data.caption || null,
      hashtags: data.hashtags || [],
      title: data.title || data.topic,
      cta: data.cta || null,
      status: data.status || "DRAFT",
      scheduled_at: data.scheduled_at || null,
      platforms: data.platforms || ["tiktok", "instagram", "facebook", "youtube"],
      account_ids: data.account_ids || [],
      platform_options: data.platform_options || {},
      approved_at: null,
      approved_by: null,
      style: data.style || null,
      target_audience: data.target_audience || null,
      shot_list: data.shot_list || null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.publicNo = Math.max(this.publicNo, row.public_no);
    this.content.push(row);
    return clone(row);
  }

  async updateContent(id, patch) {
    const row = this.content.find((item) => item.id === id);
    if (!row) return null;
    Object.assign(row, patch, { updated_at: nowIso() });
    return clone(row);
  }

  async deleteContent(id) {
    const before = this.content.length;
    this.content = this.content.filter((row) => row.id !== id);
    this.assets = this.assets.filter((row) => row.content_id !== id);
    this.jobs = this.jobs.filter((row) => row.content_id !== id);
    const scheduledIds = this.scheduled.filter((row) => row.content_id === id).map((row) => row.id);
    this.scheduled = this.scheduled.filter((row) => row.content_id !== id);
    this.posts = this.posts.filter((row) => !scheduledIds.includes(row.scheduled_post_id));
    return this.content.length !== before;
  }

  async listAssets(contentId) {
    // Newest first, matching the PostgreSQL store.
    return clone(this.assets.filter((row) => !contentId || row.content_id === contentId).reverse());
  }

  async createAsset(data) {
    const row = { id: randomUUID(), created_at: nowIso(), status: "PENDING", type: "video", ...data };
    this.assets.push(row);
    return clone(row);
  }

  async listJobs() {
    return clone(this.jobs).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  async getJob(id) {
    return clone(this.jobs.find((row) => row.id === id) || null);
  }

  async createJob(data) {
    const row = {
      id: randomUUID(),
      status: "QUEUED",
      attempt: 0,
      created_at: nowIso(),
      error_code: null,
      error_message: null,
      ...data,
    };
    this.jobs.push(row);
    return clone(row);
  }

  async updateJob(id, patch) {
    const row = this.jobs.find((item) => item.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    return clone(row);
  }

  async listAccounts() {
    const order = (row) => `${row.platform}:${row.is_default ? 0 : 1}:${row.created_at}`;
    return clone([...this.accounts].sort((a, b) => order(a).localeCompare(order(b))));
  }

  async getAccountById(id) {
    return clone(this.accounts.find((row) => row.id === id) || null);
  }

  async getDefaultAccount(platform) {
    const rows = this.accounts.filter((row) => row.platform === platform);
    return clone(rows.find((row) => row.is_default) || rows[0] || null);
  }

  // Kept for callers that think in "the account of a platform": it means the default one.
  async getAccount(platform) {
    return this.getDefaultAccount(platform);
  }

  async findAccountByExternal(platform, externalId) {
    if (!externalId) return null;
    return clone(
      this.accounts.find((row) => row.platform === platform && row.external_account_id === String(externalId)) || null
    );
  }

  async getAccountSecret(id) {
    return this.accounts.find((row) => row.id === id)?.access_token_encrypted || null;
  }

  async createAccount(platform, data) {
    const safe = { ...data };
    delete safe.access_token;
    delete safe.refresh_token;
    const row = {
      id: randomUUID(),
      platform,
      account_name: null,
      external_account_id: null,
      access_token_encrypted: null,
      refresh_token_encrypted: null,
      expires_at: null,
      scopes: [],
      status: "DISCONNECTED",
      ...safe,
      is_default: !this.accounts.some((item) => item.platform === platform && item.is_default),
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.accounts.push(row);
    return clone(row);
  }

  async updateAccount(id, patch) {
    const row = this.accounts.find((item) => item.id === id);
    if (!row) return null;
    const safe = { ...patch };
    delete safe.access_token;
    delete safe.refresh_token;
    delete safe.is_default;
    delete safe.id;
    delete safe.platform;
    Object.assign(row, safe, { updated_at: nowIso() });
    return clone(row);
  }

  async setDefaultAccount(id) {
    const row = this.accounts.find((item) => item.id === id);
    if (!row) return null;
    for (const item of this.accounts) {
      if (item.platform === row.platform) item.is_default = item.id === id;
    }
    return clone(row);
  }

  async countAccountUsage(id) {
    return this.scheduled.filter((row) => row.account_id === id).length;
  }

  async deleteAccount(id) {
    const row = this.accounts.find((item) => item.id === id);
    if (!row) return false;
    this.accounts = this.accounts.filter((item) => item.id !== id);
    if (row.is_default) {
      const next = this.accounts.find((item) => item.platform === row.platform);
      if (next) next.is_default = true;
    }
    return true;
  }

  // Legacy "one account per platform" write: updates the default account, or creates one.
  async saveAccount(platform, patch) {
    const current = await this.getDefaultAccount(platform);
    return current ? this.updateAccount(current.id, patch) : this.createAccount(platform, patch);
  }

  async listScheduled() {
    return clone(this.scheduled);
  }

  async upsertScheduled(data) {
    const accountId = data.account_id || null;
    let row = this.scheduled.find(
      (item) =>
        item.content_id === data.content_id && item.platform === data.platform && (item.account_id || null) === accountId
    );
    if (!row) {
      row = { id: randomUUID(), created_at: nowIso(), status: "SCHEDULED", ...data, account_id: accountId };
      this.scheduled.push(row);
    } else {
      Object.assign(row, data);
    }
    return clone(row);
  }

  async assignScheduledAccount(id, accountId) {
    const row = this.scheduled.find((item) => item.id === id);
    if (!row) return null;
    row.account_id = accountId;
    return clone(row);
  }

  async listPosts() {
    return clone(this.posts);
  }

  async savePost(data) {
    let row = this.posts.find(
      (item) => item.scheduled_post_id === data.scheduled_post_id && item.platform === data.platform
    );
    if (!row) {
      row = {
        id: randomUUID(),
        status: "QUEUED",
        attempts: 0,
        created_at: nowIso(),
        updated_at: nowIso(),
        ...data,
      };
      this.posts.push(row);
    } else {
      Object.assign(row, data, { updated_at: nowIso() });
    }
    return clone(row);
  }

  async getAutomation() {
    return clone(this.automation);
  }

  async saveAutomation(patch) {
    Object.assign(this.automation, patch);
    return clone(this.automation);
  }

  async getSettings() {
    return clone(this.settings);
  }

  async saveSettings(section, patch) {
    this.settings[section] = { ...this.settings[section], ...patch };
    return clone(this.settings);
  }

  async saveDeletionRequest(row) {
    this.deletions = this.deletions.filter((item) => item.confirmation_code !== row.confirmation_code);
    const saved = { created_at: nowIso(), ...row };
    this.deletions.push(saved);
    return clone(saved);
  }

  async getDeletionRequest(code) {
    return clone(this.deletions.find((item) => item.confirmation_code === String(code)) || null);
  }

  async getIdempotency(key) {
    return this.idempotency.has(key) ? clone(this.idempotency.get(key)) : null;
  }

  async putIdempotency(key, scope, response) {
    this.idempotency.set(key, { key, scope, response, created_at: nowIso() });
  }

  async addLog(entry) {
    const row = {
      id: randomUUID(),
      level: entry.level || "INFO",
      job: entry.job || null,
      content_id: entry.content_id || null,
      platform: entry.platform || null,
      request_id: entry.request_id || null,
      message: entry.message,
      metadata: entry.metadata || {},
      created_at: entry.created_at || nowIso(),
    };
    this.logs.push(row);
    this.audit.push({
      id: randomUUID(),
      actor: entry.actor || "system",
      action: entry.job || entry.level,
      entity_type: entry.content_id ? "content" : "system",
      entity_id: entry.content_id || null,
      metadata: { message: entry.message, platform: entry.platform || null },
      created_at: row.created_at,
    });
    return clone(row);
  }

  async listLogs() {
    return clone(this.logs).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  async findUserByEmail(email) {
    return clone(this.users.find((user) => user.email === email) || null);
  }

  async createUser({ email, password_hash, role }) {
    const row = { id: randomUUID(), email, password_hash, role: role || "admin", created_at: nowIso() };
    this.users.push(row);
    return clone(row);
  }

  async createSession(userId, tokenHash, expiresAt) {
    const row = { id: randomUUID(), user_id: userId, token_hash: tokenHash, expires_at: expiresAt, created_at: nowIso() };
    this.sessions.push(row);
    return clone(row);
  }

  async getSession(tokenHash) {
    const session = this.sessions.find((row) => row.token_hash === tokenHash);
    if (!session) return null;
    if (new Date(session.expires_at).getTime() < Date.now()) return null;
    const user = this.users.find((row) => row.id === session.user_id);
    return user ? { id: user.id, email: user.email, role: user.role } : null;
  }

  async deleteSession(tokenHash) {
    this.sessions = this.sessions.filter((row) => row.token_hash !== tokenHash);
  }
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = scryptSync(password, salt, 32);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

module.exports = {
  MemoryStore,
  hashPassword,
  verifyPassword,
  hashToken,
  defaultAutomation,
  defaultSettings,
};
