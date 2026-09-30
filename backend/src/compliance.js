// Rules the platforms check during API review: explicit per-post approval, TikTok post
// options chosen by the user, Meta data deletion requests, and token revocation.
const { createHmac, timingSafeEqual, randomBytes } = require("crypto");
const { httpError } = require("./domain");

// Editing any of these after approval means the user has not seen what will be posted.
const APPROVAL_FIELDS = [
  "topic",
  "hook",
  "script",
  "voice_script",
  "caption",
  "hashtags",
  "title",
  "cta",
  "platforms",
  "account_ids",
];

function approvalInvalidated(current, patch) {
  return APPROVAL_FIELDS.some(
    (field) => patch[field] !== undefined && JSON.stringify(patch[field]) !== JSON.stringify(current[field] ?? null)
  );
}

const TIKTOK_PRIVACY = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"];

// Shape check at approval time. The creator-specific check happens right before upload.
function normalizeTiktokOptions(value) {
  const input = value || {};
  const options = {
    privacy_level: String(input.privacy_level || ""),
    allow_comment: input.allow_comment === true,
    allow_duet: input.allow_duet === true,
    allow_stitch: input.allow_stitch === true,
    commercial_disclosure: input.commercial_disclosure === true,
    your_brand: input.your_brand === true,
    branded_content: input.branded_content === true,
  };
  if (!TIKTOK_PRIVACY.includes(options.privacy_level)) {
    throw httpError(400, "VALIDATION", "Choose who can view this TikTok post");
  }
  if (options.commercial_disclosure && !options.your_brand && !options.branded_content) {
    throw httpError(400, "VALIDATION", "Commercial content disclosure is on: choose Your brand and/or Branded content");
  }
  if (!options.commercial_disclosure) {
    options.your_brand = false;
    options.branded_content = false;
  }
  if (options.branded_content && options.privacy_level === "SELF_ONLY") {
    throw httpError(400, "VALIDATION", "Branded content visibility cannot be set to private");
  }
  return options;
}

// Compare the saved choice with what this creator allows right now.
function checkTiktokOptions(options, creator, durationSeconds) {
  if (!options) {
    throw httpError(409, "TIKTOK_SETTINGS_REQUIRED", "Open the approval dialog and choose TikTok post settings");
  }
  const allowed = creator.privacy_level_options || [];
  if (!allowed.includes(options.privacy_level)) {
    throw httpError(409, "TIKTOK_SETTINGS_REQUIRED", `This TikTok account does not allow privacy "${options.privacy_level}". Approve again with one of: ${allowed.join(", ")}`);
  }
  const max = Number(creator.max_video_post_duration_sec || 0);
  if (max && Number(durationSeconds || 0) > max) {
    throw httpError(409, "PUBLISH_REJECTED", `Video is ${durationSeconds}s; this TikTok account allows up to ${max}s`);
  }
  return {
    privacy_level: options.privacy_level,
    // A setting the creator has turned off in TikTok stays off.
    disable_comment: creator.comment_disabled ? true : !options.allow_comment,
    disable_duet: creator.duet_disabled ? true : !options.allow_duet,
    disable_stitch: creator.stitch_disabled ? true : !options.allow_stitch,
    brand_content_toggle: Boolean(options.branded_content),
    brand_organic_toggle: Boolean(options.your_brand),
  };
}

function tiktokDeclaration(options) {
  return options?.branded_content
    ? "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation"
    : "By posting, you agree to TikTok's Music Usage Confirmation";
}

function base64UrlDecode(value) {
  return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// Facebook signed_request: "<base64url HMAC-SHA256 signature>.<base64url JSON payload>".
function parseSignedRequest(signedRequest, appSecret) {
  const [signature, payload] = String(signedRequest || "").split(".", 2);
  if (!signature || !payload || !appSecret) return null;
  const expected = createHmac("sha256", appSecret).update(payload).digest();
  const given = base64UrlDecode(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(base64UrlDecode(payload).toString("utf8"));
    if (String(data.algorithm || "").toUpperCase() !== "HMAC-SHA256") return null;
    return data;
  } catch {
    return null;
  }
}

function confirmationCode() {
  return randomBytes(9).toString("hex").toUpperCase();
}

// Best effort: tell the platform to invalidate our tokens when the user disconnects.
async function revokeTokens(platform, tokens, config, fetchImpl = fetch) {
  if (!tokens?.access_token) return { revoked: false, reason: "no token" };
  try {
    if (platform === "youtube") {
      const response = await fetchImpl("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokens.refresh_token || tokens.access_token }).toString(),
      });
      return { revoked: response.ok || response.status === 400, status: response.status };
    }
    if (platform === "tiktok") {
      const response = await fetchImpl("https://open.tiktokapis.com/v2/oauth/revoke/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_key: config.tiktokClientKey || "",
          client_secret: config.tiktokClientSecret || "",
          token: tokens.access_token,
        }).toString(),
      });
      return { revoked: response.ok, status: response.status };
    }
    // Meta Page tokens cannot be revoked per Page; the user removes the app in Facebook
    // settings, which calls our deauthorize/data deletion callbacks.
    return { revoked: false, reason: "revoke in Facebook settings" };
  } catch (error) {
    return { revoked: false, reason: error.message };
  }
}

module.exports = {
  APPROVAL_FIELDS,
  approvalInvalidated,
  TIKTOK_PRIVACY,
  normalizeTiktokOptions,
  checkTiktokOptions,
  tiktokDeclaration,
  parseSignedRequest,
  confirmationCode,
  revokeTokens,
};
