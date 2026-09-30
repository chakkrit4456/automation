const { randomUUID } = require("crypto");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

class PgStore {
  constructor(pool) {
    this.pool = pool;
    this.client = null;
  }

  query(sql, params) {
    const runner = this.client || this.pool;
    return runner.query(sql, params);
  }

  async transaction(fn) {
    const client = await this.pool.connect();
    const bound = new PgStore(this.pool);
    bound.client = client;
    try {
      await client.query("BEGIN");
      const result = await fn(bound);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  mapContent(row) {
    if (!row) return null;
    return {
      ...row,
      hashtags: row.hashtags || [],
      platforms: row.platforms || [],
      account_ids: row.account_ids || [],
      platform_options: row.platform_options || {},
      duration_seconds: row.duration_seconds,
    };
  }

  async listContent() {
    const result = await this.query("SELECT * FROM content ORDER BY public_no DESC NULLS LAST, created_at DESC");
    return result.rows.map((row) => this.mapContent(row));
  }

  async getContent(id) {
    const result = await this.query("SELECT * FROM content WHERE id = $1", [id]);
    return this.mapContent(result.rows[0] || null);
  }

  async createContent(data) {
    const result = await this.query(
      `INSERT INTO content (
        topic, niche, language, tone, duration_seconds, hook, script, voice_script,
        visual_prompt, caption, hashtags, title, cta, status, scheduled_at, platforms,
        style, target_audience, shot_list, public_no, account_ids, platform_options
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,
        COALESCE($20::integer, nextval('content_public_no_seq')), $21::jsonb, $22::jsonb
      ) RETURNING *`,
      [
        data.topic,
        data.niche || null,
        data.language || "th",
        data.tone || null,
        data.duration_seconds ?? 45,
        data.hook || null,
        data.script || null,
        data.voice_script || null,
        data.visual_prompt || null,
        data.caption || null,
        JSON.stringify(data.hashtags || []),
        data.title || data.topic,
        data.cta || null,
        data.status || "DRAFT",
        data.scheduled_at || null,
        JSON.stringify(data.platforms || ["tiktok", "instagram", "facebook", "youtube"]),
        data.style || null,
        data.target_audience || null,
        data.shot_list || null,
        data.public_no || null,
        JSON.stringify(data.account_ids || []),
        JSON.stringify(data.platform_options || {}),
      ]
    );
    if (data.public_no) {
      await this.query(
        "SELECT setval('content_public_no_seq', GREATEST($1::bigint, (SELECT COALESCE(MAX(public_no), 1) FROM content)))",
        [data.public_no]
      );
    }
    return this.mapContent(result.rows[0]);
  }

  async updateContent(id, patch) {
    const current = await this.getContent(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    const result = await this.query(
      `UPDATE content SET
        topic=$2, niche=$3, language=$4, tone=$5, duration_seconds=$6, hook=$7, script=$8,
        voice_script=$9, visual_prompt=$10, caption=$11, hashtags=$12::jsonb, title=$13, cta=$14,
        status=$15, scheduled_at=$16, platforms=$17::jsonb, style=$18, target_audience=$19,
        shot_list=$20, account_ids=$21::jsonb, approved_at=$22, approved_by=$23,
        platform_options=$24::jsonb, updated_at=now()
      WHERE id=$1 RETURNING *`,
      [
        id,
        next.topic,
        next.niche,
        next.language,
        next.tone,
        next.duration_seconds,
        next.hook,
        next.script,
        next.voice_script,
        next.visual_prompt,
        next.caption,
        JSON.stringify(next.hashtags || []),
        next.title,
        next.cta,
        next.status,
        next.scheduled_at,
        JSON.stringify(next.platforms || []),
        next.style,
        next.target_audience,
        next.shot_list,
        JSON.stringify(next.account_ids || []),
        next.approved_at || null,
        next.approved_by || null,
        JSON.stringify(next.platform_options || {}),
      ]
    );
    return this.mapContent(result.rows[0]);
  }

  async deleteContent(id) {
    const result = await this.query("DELETE FROM content WHERE id = $1", [id]);
    return result.rowCount > 0;
  }

  async listAssets(contentId) {
    const result = contentId
      ? await this.query("SELECT * FROM media_assets WHERE content_id = $1 ORDER BY created_at DESC", [contentId])
      : await this.query("SELECT * FROM media_assets ORDER BY created_at DESC");
    return result.rows;
  }

  async createAsset(data) {
    const result = await this.query(
      `INSERT INTO media_assets (
        content_id, type, provider, storage_path, mime_type, width, height, duration_seconds,
        file_size, status, fps, audio_status, subtitle_status, pipeline
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) RETURNING *`,
      [
        data.content_id,
        data.type || "video",
        data.provider || null,
        data.storage_path || null,
        data.mime_type || null,
        data.width || null,
        data.height || null,
        data.duration_seconds || null,
        data.file_size || null,
        data.status || "PENDING",
        data.fps || null,
        data.audio_status || null,
        data.subtitle_status || null,
        JSON.stringify(data.pipeline || {}),
      ]
    );
    return result.rows[0];
  }

  async listJobs() {
    const result = await this.query("SELECT * FROM generation_jobs ORDER BY created_at DESC");
    return result.rows;
  }

  async getJob(id) {
    const result = await this.query("SELECT * FROM generation_jobs WHERE id = $1", [id]);
    return result.rows[0] || null;
  }

  async createJob(data) {
    const result = await this.query(
      `INSERT INTO generation_jobs (content_id, job_type, provider, status, attempt, error_code, error_message, started_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        data.content_id,
        data.job_type,
        data.provider || null,
        data.status || "QUEUED",
        data.attempt || 0,
        data.error_code || null,
        data.error_message || null,
        data.started_at || null,
        data.completed_at || null,
      ]
    );
    return result.rows[0];
  }

  async updateJob(id, patch) {
    const current = await this.getJob(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    const result = await this.query(
      `UPDATE generation_jobs SET status=$2, attempt=$3, error_code=$4, error_message=$5, provider=$6,
        started_at=$7, completed_at=$8 WHERE id=$1 RETURNING *`,
      [id, next.status, next.attempt, next.error_code, next.error_message, next.provider, next.started_at, next.completed_at]
    );
    return result.rows[0];
  }

  async listAccounts() {
    const result = await this.query("SELECT * FROM social_accounts ORDER BY platform, is_default DESC, created_at");
    return result.rows.map(publicAccount);
  }

  async getAccountById(id) {
    if (!isUuid(id)) return null;
    const result = await this.query("SELECT * FROM social_accounts WHERE id = $1", [id]);
    return result.rows[0] ? publicAccount(result.rows[0]) : null;
  }

  async getDefaultAccount(platform) {
    const result = await this.query(
      "SELECT * FROM social_accounts WHERE platform = $1 ORDER BY is_default DESC, created_at LIMIT 1",
      [platform]
    );
    return result.rows[0] ? publicAccount(result.rows[0]) : null;
  }

  // Kept for callers that think in "the account of a platform": it means the default one.
  async getAccount(platform) {
    return this.getDefaultAccount(platform);
  }

  async findAccountByExternal(platform, externalId) {
    if (!externalId) return null;
    const result = await this.query(
      "SELECT * FROM social_accounts WHERE platform = $1 AND external_account_id = $2 ORDER BY created_at LIMIT 1",
      [platform, String(externalId)]
    );
    return result.rows[0] ? publicAccount(result.rows[0]) : null;
  }

  async getAccountSecret(id) {
    if (!isUuid(id)) return null;
    const result = await this.query("SELECT access_token_encrypted FROM social_accounts WHERE id = $1", [id]);
    return result.rows[0]?.access_token_encrypted || null;
  }

  async createAccount(platform, data) {
    const hasDefault = await this.query("SELECT 1 FROM social_accounts WHERE platform = $1 AND is_default", [platform]);
    const inserted = await this.query(
      `INSERT INTO social_accounts (
        platform, account_name, external_account_id, access_token_encrypted, refresh_token_encrypted,
        expires_at, scopes, status, is_default
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
      [
        platform,
        data.account_name || null,
        data.external_account_id || null,
        data.access_token_encrypted || null,
        data.refresh_token_encrypted || null,
        data.expires_at || null,
        JSON.stringify(data.scopes || []),
        data.status || "DISCONNECTED",
        hasDefault.rowCount === 0,
      ]
    );
    return publicAccount(inserted.rows[0]);
  }

  async updateAccount(id, patch) {
    if (!isUuid(id)) return null;
    const existing = await this.query("SELECT * FROM social_accounts WHERE id = $1", [id]);
    if (!existing.rows[0]) return null;
    const next = { ...existing.rows[0], ...patch };
    const updated = await this.query(
      `UPDATE social_accounts SET account_name=$2, external_account_id=$3, access_token_encrypted=$4,
        refresh_token_encrypted=$5, expires_at=$6, scopes=$7::jsonb, status=$8, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [
        id,
        next.account_name,
        next.external_account_id,
        next.access_token_encrypted,
        next.refresh_token_encrypted,
        next.expires_at,
        JSON.stringify(next.scopes || []),
        next.status,
      ]
    );
    return publicAccount(updated.rows[0]);
  }

  async setDefaultAccount(id) {
    const account = await this.getAccountById(id);
    if (!account) return null;
    await this.query("UPDATE social_accounts SET is_default = false WHERE platform = $1 AND is_default AND id <> $2", [
      account.platform,
      id,
    ]);
    const result = await this.query("UPDATE social_accounts SET is_default = true, updated_at = now() WHERE id = $1 RETURNING *", [id]);
    return publicAccount(result.rows[0]);
  }

  async countAccountUsage(id) {
    const result = await this.query("SELECT count(*)::int AS n FROM scheduled_posts WHERE account_id = $1", [id]);
    return result.rows[0].n;
  }

  async deleteAccount(id) {
    const account = await this.getAccountById(id);
    if (!account) return false;
    await this.query("DELETE FROM social_accounts WHERE id = $1", [id]);
    if (account.is_default) {
      // Promote the next oldest account so the platform keeps a default.
      await this.query(
        `UPDATE social_accounts SET is_default = true
         WHERE id = (SELECT id FROM social_accounts WHERE platform = $1 ORDER BY created_at LIMIT 1)`,
        [account.platform]
      );
    }
    return true;
  }

  // Legacy "one account per platform" write: updates the default account, or creates one.
  async saveAccount(platform, patch) {
    const current = await this.getDefaultAccount(platform);
    return current ? this.updateAccount(current.id, patch) : this.createAccount(platform, patch);
  }

  async listScheduled() {
    const result = await this.query("SELECT * FROM scheduled_posts ORDER BY scheduled_at");
    return result.rows;
  }

  async upsertScheduled(data) {
    const result = await this.query(
      `INSERT INTO scheduled_posts (content_id, platform, account_id, scheduled_at, status)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (content_id, platform, (COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid)))
       DO UPDATE SET scheduled_at = EXCLUDED.scheduled_at, status = EXCLUDED.status
       RETURNING *`,
      [data.content_id, data.platform, data.account_id || null, data.scheduled_at, data.status || "SCHEDULED"]
    );
    return result.rows[0];
  }

  async assignScheduledAccount(id, accountId) {
    const result = await this.query("UPDATE scheduled_posts SET account_id = $2 WHERE id = $1 RETURNING *", [id, accountId]);
    return result.rows[0] || null;
  }

  async listPosts() {
    const result = await this.query("SELECT * FROM social_posts ORDER BY created_at DESC");
    return result.rows;
  }

  async savePost(data) {
    const result = await this.query(
      `INSERT INTO social_posts (
        scheduled_post_id, platform, external_post_id, status, attempts, last_error_code, last_error_message, published_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (scheduled_post_id, platform)
      DO UPDATE SET
        external_post_id = COALESCE(EXCLUDED.external_post_id, social_posts.external_post_id),
        status = EXCLUDED.status,
        attempts = EXCLUDED.attempts,
        last_error_code = EXCLUDED.last_error_code,
        last_error_message = EXCLUDED.last_error_message,
        published_at = EXCLUDED.published_at,
        updated_at = now()
      RETURNING *`,
      [
        data.scheduled_post_id,
        data.platform,
        data.external_post_id || null,
        data.status || "QUEUED",
        data.attempts || 0,
        data.last_error_code || null,
        data.last_error_message || null,
        data.published_at || null,
      ]
    );
    return result.rows[0];
  }

  async getAutomation() {
    const result = await this.query("SELECT * FROM automation_settings LIMIT 1");
    if (!result.rows[0]) {
      const inserted = await this.query(
        `INSERT INTO automation_settings (enabled, timezone, daily_quantity, publish_time, generation_lead_days, generation_lead_hours, max_concurrent_jobs, retry_count, retry_backoff_seconds, platforms)
         VALUES (false, 'Asia/Bangkok', 1, '09:00', 3, 3, 1, 3, 600, '["tiktok","instagram","facebook","youtube"]'::jsonb)
         RETURNING *`
      );
      return normalizeAutomation(inserted.rows[0]);
    }
    return normalizeAutomation(result.rows[0]);
  }

  async saveAutomation(patch) {
    const current = await this.getAutomation();
    const next = { ...current, ...patch };
    const result = await this.query(
      `UPDATE automation_settings SET enabled=$2, timezone=$3, daily_quantity=$4, publish_time=$5,
        generation_lead_days=$6, generation_lead_hours=$7, max_concurrent_jobs=$8, retry_count=$9,
        retry_backoff_seconds=$10, platforms=$11::jsonb, account_ids=$12::jsonb WHERE id=$1 RETURNING *`,
      [
        current.id,
        next.enabled,
        next.timezone,
        next.daily_quantity,
        next.publish_time,
        next.generation_lead_days,
        next.generation_lead_hours,
        next.max_concurrent_jobs,
        next.retry_count,
        next.retry_backoff_seconds,
        JSON.stringify(next.platforms || []),
        JSON.stringify(next.account_ids || []),
      ]
    );
    return normalizeAutomation(result.rows[0]);
  }

  async getSettings() {
    const result = await this.query("SELECT * FROM app_settings LIMIT 1");
    if (!result.rows[0]) {
      await this.query("INSERT INTO app_settings (id) VALUES (true)");
      return this.getSettings();
    }
    const row = result.rows[0];
    return {
      general: row.general || {},
      ai: row.ai || {},
      video: row.video || {},
      storage: row.storage || {},
      social: row.social || {},
      security: row.security || {},
      notifications: row.notifications || {},
    };
  }

  async saveSettings(section, patch) {
    const allowed = ["general", "ai", "video", "storage", "social", "security", "notifications"];
    if (!allowed.includes(section)) throw new Error("Unknown settings section");
    const current = await this.getSettings();
    const next = { ...current[section], ...patch };
    await this.query(`UPDATE app_settings SET ${section} = $1::jsonb, updated_at = now() WHERE id = true`, [
      JSON.stringify(next),
    ]);
    return this.getSettings();
  }

  async getIdempotency(key) {
    const result = await this.query("SELECT * FROM idempotency_keys WHERE key = $1", [key]);
    return result.rows[0] || null;
  }

  async putIdempotency(key, scope, response) {
    await this.query(
      `INSERT INTO idempotency_keys (key, scope, response) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [key, scope, JSON.stringify(response)]
    );
  }

  async addLog(entry) {
    const result = await this.query(
      `INSERT INTO app_logs (level, job, content_id, platform, request_id, message, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
      [
        entry.level || "INFO",
        entry.job || null,
        entry.content_id || null,
        entry.platform || null,
        entry.request_id || null,
        entry.message,
        JSON.stringify(entry.metadata || {}),
      ]
    );
    await this.query(
      `INSERT INTO audit_logs (actor, action, entity_type, entity_id, metadata)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [
        entry.actor || "system",
        entry.job || entry.level || "log",
        entry.content_id ? "content" : "system",
        entry.content_id || null,
        JSON.stringify({ message: entry.message, platform: entry.platform || null }),
      ]
    );
    return result.rows[0];
  }

  async listLogs() {
    const result = await this.query("SELECT * FROM app_logs ORDER BY created_at DESC LIMIT 500");
    return result.rows;
  }

  async findUserByEmail(email) {
    const result = await this.query("SELECT * FROM users WHERE email = $1", [email]);
    return result.rows[0] || null;
  }

  async createUser({ email, password_hash, role }) {
    const result = await this.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING *",
      [email, password_hash, role || "admin"]
    );
    return result.rows[0];
  }

  async createSession(userId, tokenHash, expiresAt) {
    const result = await this.query(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1,$2,$3) RETURNING *",
      [userId, tokenHash, expiresAt]
    );
    return result.rows[0];
  }

  async getSession(tokenHash) {
    const result = await this.query(
      `SELECT u.id, u.email, u.role FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [tokenHash]
    );
    return result.rows[0] || null;
  }

  async deleteSession(tokenHash) {
    await this.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
  }

  async saveDeletionRequest(row) {
    const result = await this.query(
      `INSERT INTO data_deletion_requests (confirmation_code, platform, external_user_id, status, accounts_affected, detail, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (confirmation_code) DO UPDATE SET status = EXCLUDED.status,
         accounts_affected = EXCLUDED.accounts_affected, detail = EXCLUDED.detail, completed_at = EXCLUDED.completed_at
       RETURNING *`,
      [row.confirmation_code, row.platform, row.external_user_id, row.status, row.accounts_affected || 0, row.detail || null, row.completed_at || null]
    );
    return result.rows[0];
  }

  async getDeletionRequest(code) {
    const result = await this.query("SELECT * FROM data_deletion_requests WHERE confirmation_code = $1", [String(code)]);
    return result.rows[0] || null;
  }

  async ping() {
    await this.query("SELECT 1");
  }
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function publicAccount(row) {
  return {
    ...row,
    scopes: row.scopes || [],
    access_token_encrypted: row.access_token_encrypted ? "[encrypted]" : null,
    refresh_token_encrypted: row.refresh_token_encrypted ? "[encrypted]" : null,
    has_token: Boolean(row.access_token_encrypted),
  };
}

function normalizeAutomation(row) {
  const publish = row.publish_time;
  const publishTime = typeof publish === "string" ? publish.slice(0, 5) : "09:00";
  return {
    ...row,
    publish_time: publishTime,
    platforms: row.platforms || [],
    account_ids: row.account_ids || [],
    max_concurrent_jobs: Number(row.max_concurrent_jobs || 1),
  };
}

const DATABASE_DIR = path.resolve(__dirname, "..", "..", "database");

async function ensureSchema(pool, options = {}) {
  const sql = fs.readFileSync(path.join(DATABASE_DIR, "schema.sql"), "utf8");
  await pool.query(sql);
  return runMigrations(pool, options);
}

// Apply database/migrations/NNN_name.sql files once each, in order, each in its own
// transaction. *.down.sql files are rollbacks and are only ever run by hand.
async function runMigrations(pool, options = {}) {
  const dir = options.migrationsDir || path.join(DATABASE_DIR, "migrations");
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => /^\d+_.+\.sql$/.test(name) && !name.endsWith(".down.sql")).sort()
    : [];
  const client = await pool.connect();
  const applied = [];
  try {
    // Serialize concurrent starts (e.g. two app containers) on one database.
    await client.query("SELECT pg_advisory_lock(hashtext('ai_social_migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Set((await client.query("SELECT version FROM schema_migrations")).rows.map((row) => row.version));
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (done.has(version)) continue;
      const body = fs.readFileSync(path.join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(body);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
        applied.push(version);
      } catch (error) {
        await client.query("ROLLBACK");
        error.message = `Migration ${file} failed and was rolled back: ${error.message}`;
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('ai_social_migrations'))").catch(() => {});
    client.release();
  }
  return applied;
}

function createPool(databaseUrl, max) {
  return new Pool({
    connectionString: databaseUrl,
    max: Number(max || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

module.exports = { PgStore, ensureSchema, runMigrations, createPool, randomUUID };
