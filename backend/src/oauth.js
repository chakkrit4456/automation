const { createHmac, randomBytes, timingSafeEqual } = require("crypto");
const { httpError } = require("./domain");

const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "business_management",
];

function graphBase(config) {
  return `https://graph.facebook.com/${config.metaGraphVersion || "v23.0"}`;
}

function redirectUri(platform, config) {
  return `${String(config.publicUrl || "").replace(/\/$/, "")}/api/social/${platform}/callback`;
}

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function createState(platform, secret, now = Date.now()) {
  const body = `${platform}.${now + 10 * 60_000}.${randomBytes(12).toString("base64url")}`;
  return `${body}.${sign(body, secret)}`;
}

function verifyState(state, platform, secret, now = Date.now()) {
  const parts = String(state || "").split(".");
  if (parts.length !== 4) return false;
  const body = parts.slice(0, 3).join(".");
  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(parts[3]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  return parts[0] === platform && Number(parts[1]) > now;
}

function isConfigured(platform, config) {
  if (platform === "youtube") return Boolean(config.youtubeClientId && config.youtubeClientSecret);
  if (platform === "tiktok") return Boolean(config.tiktokClientKey && config.tiktokClientSecret);
  return Boolean(config.metaAppId && config.metaAppSecret);
}

function authorizeUrl(platform, config, state) {
  if (!isConfigured(platform, config)) return null;
  const redirect = encodeURIComponent(redirectUri(platform, config));
  if (platform === "youtube") {
    const scope = encodeURIComponent(
      "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly"
    );
    return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(config.youtubeClientId)}&redirect_uri=${redirect}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&include_granted_scopes=true&state=${state}`;
  }
  if (platform === "tiktok") {
    return `https://www.tiktok.com/v2/auth/authorize/?client_key=${encodeURIComponent(config.tiktokClientKey)}&redirect_uri=${redirect}&response_type=code&scope=${encodeURIComponent("user.info.basic,video.publish,video.upload")}&state=${state}`;
  }
  const version = config.metaGraphVersion || "v23.0";
  return `https://www.facebook.com/${version}/dialog/oauth?client_id=${encodeURIComponent(config.metaAppId)}&redirect_uri=${redirect}&response_type=code&scope=${META_SCOPES.join(",")}&state=${state}`;
}

async function callJson(fetchImpl, url, init, label) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw httpError(502, "UPSTREAM", `${label}: ${error.message}`);
  }
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  if (!response.ok || body.error?.code && body.error.code !== "ok" || typeof body.error === "string") {
    throw upstreamError(response.status, body, label);
  }
  return { body, response };
}

function upstreamError(status, body, label) {
  const detail =
    body.error_description ||
    body.error?.message ||
    body.error?.error_user_msg ||
    (typeof body.error === "string" ? body.error : "") ||
    body.raw ||
    `HTTP ${status}`;
  const metaCode = body.error?.code;
  let code = "PUBLISH_REJECTED";
  if (status === 401 || metaCode === 190 || body.error?.code === "access_token_invalid" || body.error === "invalid_grant") {
    code = "OAUTH_EXPIRED";
  } else if (status === 429 || metaCode === 4 || metaCode === 17 || metaCode === 32 || body.error?.code === "rate_limit_exceeded") {
    code = "RATE_LIMITED";
  } else if (status >= 500 || status === 0) {
    code = "UPSTREAM";
  }
  return httpError(502, code, `${label}: ${detail}`);
}

function isoIn(seconds) {
  return seconds ? new Date(Date.now() + Number(seconds) * 1000).toISOString() : null;
}

function form(values) {
  return new URLSearchParams(Object.entries(values).filter(([, value]) => value != null)).toString();
}

async function exchangeCode(platform, code, config, fetchImpl = fetch) {
  const redirect = redirectUri(platform, config);
  if (platform === "youtube") {
    const { body: token } = await callJson(
      fetchImpl,
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({
          code,
          client_id: config.youtubeClientId,
          client_secret: config.youtubeClientSecret,
          redirect_uri: redirect,
          grant_type: "authorization_code",
        }),
      },
      "Google token"
    );
    const { body: channels } = await callJson(
      fetchImpl,
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { authorization: `Bearer ${token.access_token}` } },
      "YouTube channel"
    );
    const channel = channels.items?.[0];
    if (!channel) throw httpError(400, "NOT_CONNECTED", "This Google account has no YouTube channel");
    return {
      accounts: [
        {
          account_name: channel.snippet?.title || "YouTube",
          external_account_id: channel.id,
          scopes: String(token.scope || "").split(" ").filter(Boolean),
          expires_at: null,
          tokens: {
            access_token: token.access_token,
            access_expires_at: isoIn(token.expires_in),
            refresh_token: token.refresh_token || null,
          },
        },
      ],
    };
  }

  if (platform === "tiktok") {
    const { body: token } = await callJson(
      fetchImpl,
      "https://open.tiktokapis.com/v2/oauth/token/",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({
          client_key: config.tiktokClientKey,
          client_secret: config.tiktokClientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirect,
        }),
      },
      "TikTok token"
    );
    let name = "TikTok";
    try {
      const { body: user } = await callJson(
        fetchImpl,
        "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name",
        { headers: { authorization: `Bearer ${token.access_token}` } },
        "TikTok user"
      );
      name = user.data?.user?.display_name || name;
    } catch {
      // Name lookup is cosmetic; the token is what matters.
    }
    return {
      accounts: [
        {
          account_name: name,
          external_account_id: token.open_id || null,
          scopes: String(token.scope || "").split(",").filter(Boolean),
          expires_at: isoIn(token.refresh_expires_in),
          tokens: {
            access_token: token.access_token,
            access_expires_at: isoIn(token.expires_in),
            refresh_token: token.refresh_token || null,
          },
        },
      ],
    };
  }

  // Facebook and Instagram both go through Facebook Login and a Page token.
  const graph = graphBase(config);
  const { body: short } = await callJson(
    fetchImpl,
    `${graph}/oauth/access_token?${form({
      client_id: config.metaAppId,
      client_secret: config.metaAppSecret,
      redirect_uri: redirect,
      code,
    })}`,
    {},
    "Meta token"
  );
  const { body: long } = await callJson(
    fetchImpl,
    `${graph}/oauth/access_token?${form({
      grant_type: "fb_exchange_token",
      client_id: config.metaAppId,
      client_secret: config.metaAppSecret,
      fb_exchange_token: short.access_token,
    })}`,
    {},
    "Meta long-lived token"
  );
  const { body: pages } = await callJson(
    fetchImpl,
    `${graph}/me/accounts?${form({
      fields: "id,name,access_token,instagram_business_account{id,username}",
      access_token: long.access_token,
    })}`,
    {},
    "Meta pages"
  );
  // Remember which Facebook user granted these Pages, to honour data deletion requests.
  const { body: me } = await callJson(
    fetchImpl,
    `${graph}/me?${form({ fields: "id", access_token: long.access_token })}`,
    {},
    "Meta user"
  );
  // Facebook Login lets the user tick which Pages to grant; every granted Page becomes an
  // account. META_PAGE_ID, when set, limits this to one Page.
  const list = (pages.data || []).filter((page) => !config.metaPageId || page.id === config.metaPageId);
  if (platform === "instagram") {
    const linked = list.filter((page) => page.instagram_business_account);
    if (!linked.length) {
      throw httpError(
        400,
        "NOT_CONNECTED",
        "No Instagram professional account is linked to a Facebook Page you granted"
      );
    }
    return {
      accounts: linked.map((page) => ({
        account_name: page.instagram_business_account.username || page.name,
        external_account_id: page.instagram_business_account.id,
        scopes: META_SCOPES,
        expires_at: null,
        tokens: { access_token: page.access_token, access_expires_at: null, refresh_token: null, page_id: page.id, meta_user_id: me.id },
      })),
    };
  }
  if (!list.length) throw httpError(400, "NOT_CONNECTED", "No Facebook Page was granted to this app");
  return {
    accounts: list.map((page) => ({
      account_name: page.name,
      external_account_id: page.id,
      scopes: META_SCOPES,
      expires_at: null,
      tokens: { access_token: page.access_token, access_expires_at: null, refresh_token: null, meta_user_id: me.id },
    })),
  };
}

async function refreshTokens(platform, tokens, config, fetchImpl = fetch) {
  if (!tokens.refresh_token) {
    throw httpError(401, "OAUTH_EXPIRED", "Access token expired and there is no refresh token. Reconnect the account.");
  }
  if (platform === "youtube") {
    const { body } = await callJson(
      fetchImpl,
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({
          client_id: config.youtubeClientId,
          client_secret: config.youtubeClientSecret,
          refresh_token: tokens.refresh_token,
          grant_type: "refresh_token",
        }),
      },
      "Google refresh"
    );
    return {
      ...tokens,
      access_token: body.access_token,
      access_expires_at: isoIn(body.expires_in),
      refresh_token: body.refresh_token || tokens.refresh_token,
    };
  }
  if (platform === "tiktok") {
    const { body } = await callJson(
      fetchImpl,
      "https://open.tiktokapis.com/v2/oauth/token/",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form({
          client_key: config.tiktokClientKey,
          client_secret: config.tiktokClientSecret,
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
        }),
      },
      "TikTok refresh"
    );
    return {
      ...tokens,
      access_token: body.access_token,
      access_expires_at: isoIn(body.expires_in),
      refresh_token: body.refresh_token || tokens.refresh_token,
    };
  }
  throw httpError(401, "OAUTH_EXPIRED", "Page token is no longer valid. Reconnect the account.");
}

module.exports = {
  META_SCOPES,
  graphBase,
  redirectUri,
  createState,
  verifyState,
  isConfigured,
  authorizeUrl,
  exchangeCode,
  refreshTokens,
  callJson,
  upstreamError,
};
