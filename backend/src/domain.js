const PLATFORMS = ["tiktok", "instagram", "facebook", "youtube"];

const AI_FIELDS = [
  "topic",
  "hook",
  "script",
  "voice_script",
  "visual_prompt",
  "caption",
  "hashtags",
  "title",
  "cta",
];

const PERMANENT_ERRORS = new Set([
  "OAUTH_EXPIRED",
  "NOT_CONNECTED",
  "NOT_CONFIGURED",
  "MANUAL_APPROVAL",
  "CANCELLED",
  "VALIDATION",
  "MEDIA_MISSING",
  "PUBLISH_REJECTED",
]);

function httpError(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details || null;
  return error;
}

function normalizeHashtags(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizePlatforms(value) {
  const list = Array.isArray(value) ? value : [];
  const unique = [...new Set(list.map((item) => String(item).toLowerCase()))];
  const unknown = unique.filter((item) => !PLATFORMS.includes(item));
  if (unknown.length) {
    throw httpError(400, "VALIDATION", `Unknown platform: ${unknown.join(", ")}`);
  }
  if (!unique.length) {
    throw httpError(400, "VALIDATION", "Select at least one platform");
  }
  return unique;
}

function validateGenerateInput(body) {
  const input = body || {};
  const topic = String(input.topic || "").trim();
  if (!topic) throw httpError(400, "VALIDATION", "topic is required");
  const count = Number(input.count ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 5) {
    throw httpError(400, "VALIDATION", "count must be an integer from 1 to 5");
  }
  const duration = Number(input.duration_seconds ?? 45);
  if (!Number.isFinite(duration) || duration < 5 || duration > 180) {
    throw httpError(400, "VALIDATION", "duration_seconds must be between 5 and 180");
  }
  return {
    topic,
    niche: String(input.niche || "").trim(),
    language: String(input.language || "th").trim() || "th",
    duration_seconds: duration,
    tone: String(input.tone || "friendly").trim(),
    style: String(input.style || "").trim(),
    cta: String(input.cta || "").trim(),
    count,
    platforms: input.platforms ? normalizePlatforms(input.platforms) : [...PLATFORMS],
    target_audience: String(input.target_audience || "").trim(),
    publish_from: input.publish_from || null,
    publish_to: input.publish_to || null,
  };
}

function validateAiOutput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(502, "AI_INVALID", "Model output is not a JSON object");
  }
  const missing = AI_FIELDS.filter((field) => value[field] == null || value[field] === "");
  if (missing.length) {
    throw httpError(502, "AI_INVALID", `Model output missing: ${missing.join(", ")}`);
  }
  return {
    topic: String(value.topic),
    hook: String(value.hook),
    script: String(value.script),
    voice_script: String(value.voice_script),
    visual_prompt: String(value.visual_prompt),
    caption: String(value.caption),
    hashtags: normalizeHashtags(value.hashtags),
    title: String(value.title),
    cta: String(value.cta),
    shot_list: value.shot_list ? String(value.shot_list) : "",
  };
}

function duplicateKey(topic, hook) {
  return `${String(topic || "").trim().toLowerCase()}::${String(hook || "").trim().toLowerCase()}`;
}

function isDuplicate(existing, topic, hook) {
  if (!hook) return false;
  const key = duplicateKey(topic, hook);
  return existing.some((row) => duplicateKey(row.topic, row.hook) === key && row.status !== "CANCELLED");
}

function isPermanentError(code) {
  return PERMANENT_ERRORS.has(code);
}

function shouldAutoRetry({ errorCode, attempts, maxAttempts }) {
  if (isPermanentError(errorCode)) return false;
  return Number(attempts || 0) < Number(maxAttempts || 0);
}

function contentStatusFromPosts(posts) {
  if (!posts.length) return "READY";
  const success = posts.filter((post) => post.status === "SUCCESS").length;
  const failed = posts.filter((post) => post.status === "FAILED").length;
  const pending = posts.length - success - failed;
  if (success && failed) return "PARTIAL";
  if (failed && !success && !pending) return "FAILED";
  if (success && !failed && !pending) return "PUBLISHED";
  if (pending && !success && !failed) return "SCHEDULED";
  if (success && pending) return "SCHEDULED";
  return "FAILED";
}

function aggregatePublishStatus(results) {
  const statuses = results.map((item) => item.status);
  if (!statuses.length) return "FAILED";
  const successes = statuses.filter((status) => status === "SUCCESS").length;
  if (successes === statuses.length) return "PUBLISHED";
  if (successes === 0) return "FAILED";
  return "PARTIAL";
}

function idempotentPublishDecision(existing) {
  if (existing && existing.status === "SUCCESS") {
    return { action: "skip", reason: "already_published" };
  }
  return { action: "publish" };
}

function validateMedia(asset, options = {}) {
  const maxMb = Number(options.maxMb || 500);
  const errors = [];
  if (!asset) {
    errors.push("file missing");
    return errors;
  }
  if (asset.status === "FAILED") errors.push("processing failed");
  if (asset.mime_type && asset.mime_type !== "video/mp4") errors.push("container must be MP4");
  if (asset.width && asset.height && Number(asset.width) > Number(asset.height)) {
    errors.push("aspect ratio must be vertical");
  }
  if (asset.duration_seconds != null) {
    const duration = Number(asset.duration_seconds);
    if (duration < 5 || duration > 180) errors.push("duration out of range");
  }
  if (asset.file_size != null && Number(asset.file_size) > maxMb * 1024 * 1024) {
    errors.push("file exceeds size limit");
  }
  if (asset.provider !== "mock" && !asset.storage_path) errors.push("file missing");
  return errors;
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
  };
}

function tzDateKey(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}

function parseTime(value) {
  const match = String(value || "09:00").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return { hour: 9, minute: 0 };
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function zonedInstant(year, month, day, hour, minute, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = zonedOffset(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}

function zonedOffset(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function nextPublishInstant(settings, now) {
  const timeZone = settings.timezone || "Asia/Bangkok";
  const clock = parseTime(settings.publish_time);
  const parts = zonedParts(now, timeZone);
  let instant = zonedInstant(parts.year, parts.month, parts.day, clock.hour, clock.minute, timeZone);
  if (instant.getTime() <= now.getTime()) {
    const tomorrow = new Date(instant.getTime() + 24 * 60 * 60 * 1000);
    const next = zonedParts(tomorrow, timeZone);
    instant = zonedInstant(next.year, next.month, next.day, clock.hour, clock.minute, timeZone);
  }
  return instant;
}

function shouldGenerateAhead(settings, now) {
  if (!settings.enabled) return false;
  const publishAt = nextPublishInstant(settings, now);
  const leadMs = Number(settings.generation_lead_hours ?? 3) * 60 * 60 * 1000;
  return now.getTime() >= publishAt.getTime() - leadMs && now.getTime() < publishAt.getTime();
}

function accountIsExpired(account, now = new Date()) {
  if (!account) return true;
  if (account.status === "DISCONNECTED" || account.status === "TOKEN_EXPIRED") return true;
  if (account.expires_at && new Date(account.expires_at).getTime() <= now.getTime()) return true;
  return false;
}

module.exports = {
  PLATFORMS,
  AI_FIELDS,
  httpError,
  normalizeHashtags,
  normalizePlatforms,
  validateGenerateInput,
  validateAiOutput,
  duplicateKey,
  isDuplicate,
  isPermanentError,
  shouldAutoRetry,
  contentStatusFromPosts,
  aggregatePublishStatus,
  idempotentPublishDecision,
  validateMedia,
  tzDateKey,
  nextPublishInstant,
  shouldGenerateAhead,
  accountIsExpired,
  zonedParts,
};
