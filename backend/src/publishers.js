const fs = require("fs");
const { httpError } = require("./domain");
const { callJson, graphBase } = require("./oauth");
const { checkTiktokOptions } = require("./compliance");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hashtagText(content) {
  return (content.hashtags || []).map((tag) => (String(tag).startsWith("#") ? tag : `#${tag}`)).join(" ");
}

function captionText(content, max = 2200) {
  return [content.caption, hashtagText(content)].filter(Boolean).join("\n\n").slice(0, max);
}

function readVideo(video) {
  if (!video?.path || !fs.existsSync(video.path)) {
    throw httpError(409, "MEDIA_MISSING", "Rendered MP4 file was not found. Render the video again.");
  }
  return fs.readFileSync(video.path);
}

async function publishYoutube({ token, content, video, config, fetchImpl }) {
  const data = readVideo(video);
  const baseTitle = String(content.title || content.topic || "Short").slice(0, 90);
  const metadata = {
    snippet: {
      title: baseTitle.includes("#Shorts") ? baseTitle : `${baseTitle} #Shorts`,
      description: captionText(content, 4900),
      tags: (content.hashtags || []).map((tag) => String(tag).replace(/^#/, "")).slice(0, 15),
      categoryId: config.youtubeCategoryId || "22",
    },
    status: {
      privacyStatus: config.youtubePrivacy || "public",
      selfDeclaredMadeForKids: false,
    },
  };
  const { response } = await callJson(
    fetchImpl,
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(data.length),
        "x-upload-content-type": "video/mp4",
      },
      body: JSON.stringify(metadata),
    },
    "YouTube upload init"
  );
  const location = response.headers.get("location");
  if (!location) throw httpError(502, "UPSTREAM", "YouTube did not return an upload URL");
  const { body } = await callJson(
    fetchImpl,
    location,
    { method: "PUT", headers: { "content-type": "video/mp4", "content-length": String(data.length) }, body: data },
    "YouTube upload"
  );
  return { external_id: body.id, url: `https://www.youtube.com/shorts/${body.id}` };
}

async function publishFacebook({ token, account, content, video, config, fetchImpl }) {
  const data = readVideo(video);
  const graph = graphBase(config);
  const version = config.metaGraphVersion || "v23.0";
  const pageId = account.external_account_id;
  if (!pageId) throw httpError(409, "NOT_CONNECTED", "Facebook Page id is missing. Reconnect the account.");
  const { body: start } = await callJson(
    fetchImpl,
    `${graph}/${pageId}/video_reels`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ upload_phase: "start", access_token: token }),
    },
    "Facebook Reels start"
  );
  await callJson(
    fetchImpl,
    start.upload_url || `https://rupload.facebook.com/video-upload/${version}/${start.video_id}`,
    {
      method: "POST",
      headers: { authorization: `OAuth ${token}`, offset: "0", file_size: String(data.length) },
      body: data,
    },
    "Facebook Reels upload"
  );
  await callJson(
    fetchImpl,
    `${graph}/${pageId}/video_reels?${new URLSearchParams({
      access_token: token,
      video_id: start.video_id,
      upload_phase: "finish",
      video_state: "PUBLISHED",
      description: captionText(content),
    })}`,
    { method: "POST" },
    "Facebook Reels publish"
  );
  return { external_id: start.video_id, url: `https://www.facebook.com/reel/${start.video_id}` };
}

async function publishInstagram({ token, account, content, video, config, fetchImpl, pollMs = 5000 }) {
  const data = readVideo(video);
  const graph = graphBase(config);
  const version = config.metaGraphVersion || "v23.0";
  const igId = account.external_account_id;
  if (!igId) throw httpError(409, "NOT_CONNECTED", "Instagram account id is missing. Reconnect the account.");
  const { body: container } = await callJson(
    fetchImpl,
    `${graph}/${igId}/media?${new URLSearchParams({
      media_type: "REELS",
      upload_type: "resumable",
      caption: captionText(content),
      share_to_feed: "true",
      access_token: token,
    })}`,
    { method: "POST" },
    "Instagram container"
  );
  await callJson(
    fetchImpl,
    container.uri || `https://rupload.facebook.com/ig-api-upload/${version}/${container.id}`,
    {
      method: "POST",
      headers: { authorization: `OAuth ${token}`, offset: "0", file_size: String(data.length) },
      body: data,
    },
    "Instagram upload"
  );
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { body: state } = await callJson(
      fetchImpl,
      `${graph}/${container.id}?fields=status_code,status&access_token=${encodeURIComponent(token)}`,
      {},
      "Instagram status"
    );
    if (state.status_code === "FINISHED") break;
    if (state.status_code === "ERROR" || state.status_code === "EXPIRED") {
      throw httpError(502, "PUBLISH_REJECTED", `Instagram processing failed: ${state.status || state.status_code}`);
    }
    if (attempt === 59) throw httpError(504, "UPSTREAM", "Instagram is still processing the video. Retry later.");
    await sleep(pollMs);
  }
  const { body: published } = await callJson(
    fetchImpl,
    `${graph}/${igId}/media_publish?${new URLSearchParams({ creation_id: container.id, access_token: token })}`,
    { method: "POST" },
    "Instagram publish"
  );
  return { external_id: published.id };
}

function tiktokChunks(size) {
  const MB = 1024 * 1024;
  if (size <= 64 * MB) return { chunkSize: size, count: 1 };
  const chunkSize = 10 * MB;
  return { chunkSize, count: Math.floor(size / chunkSize) };
}

async function tiktokCreatorInfo(token, fetchImpl = fetch) {
  const { body } = await callJson(
    fetchImpl,
    "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" },
      body: "{}",
    },
    "TikTok creator info"
  );
  return body.data || {};
}

async function publishTiktok({ token, content, video, fetchImpl, pollMs = 5000 }) {
  const data = readVideo(video);
  const api = "https://open.tiktokapis.com/v2/post/publish";
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" };
  // Fresh creator info on every post, as TikTok's guidelines require. The privacy level and
  // interaction settings come from what the user chose when approving the post.
  const creator = await tiktokCreatorInfo(token, fetchImpl);
  const postInfo = checkTiktokOptions(content.platform_options?.tiktok, creator, video.duration);
  const privacy = postInfo.privacy_level;
  const { chunkSize, count } = tiktokChunks(data.length);
  const { body: init } = await callJson(
    fetchImpl,
    `${api}/video/init/`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        post_info: { title: captionText(content, 2200), ...postInfo },
        source_info: { source: "FILE_UPLOAD", video_size: data.length, chunk_size: chunkSize, total_chunk_count: count },
      }),
    },
    "TikTok init"
  );
  const publishId = init.data?.publish_id;
  const uploadUrl = init.data?.upload_url;
  if (!publishId || !uploadUrl) throw httpError(502, "UPSTREAM", "TikTok did not return an upload URL");
  for (let index = 0; index < count; index += 1) {
    const start = index * chunkSize;
    const end = index === count - 1 ? data.length : start + chunkSize;
    const part = data.subarray(start, end);
    const response = await fetchImpl(uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": "video/mp4",
        "content-length": String(part.length),
        "content-range": `bytes ${start}-${end - 1}/${data.length}`,
      },
      body: part,
    });
    if (!response.ok) throw httpError(502, response.status >= 500 ? "UPSTREAM" : "PUBLISH_REJECTED", `TikTok upload chunk ${index + 1} failed: HTTP ${response.status}`);
  }
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const { body } = await callJson(
      fetchImpl,
      `${api}/status/fetch/`,
      { method: "POST", headers, body: JSON.stringify({ publish_id: publishId }) },
      "TikTok status"
    );
    const status = body.data?.status;
    if (status === "PUBLISH_COMPLETE") {
      const postId = body.data?.publicaly_available_post_id?.[0] || body.data?.publicly_available_post_id?.[0];
      return { external_id: postId ? String(postId) : publishId, privacy };
    }
    if (status === "FAILED") {
      throw httpError(502, "PUBLISH_REJECTED", `TikTok rejected the post: ${body.data?.fail_reason || "unknown reason"}`);
    }
    await sleep(pollMs);
  }
  // Still processing on TikTok's side. The upload itself succeeded.
  return { external_id: publishId, privacy, note: "TikTok is still processing" };
}

const PUBLISHERS = {
  youtube: publishYoutube,
  facebook: publishFacebook,
  instagram: publishInstagram,
  tiktok: publishTiktok,
};

async function publishLive(platform, input) {
  const fn = PUBLISHERS[platform];
  if (!fn) throw httpError(400, "VALIDATION", `Unknown platform: ${platform}`);
  return fn({ fetchImpl: fetch, ...input });
}

async function verifyAccount(platform, { token, account, config, fetchImpl = fetch }) {
  if (platform === "youtube") {
    const { body } = await callJson(
      fetchImpl,
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { authorization: `Bearer ${token}` } },
      "YouTube"
    );
    return { name: body.items?.[0]?.snippet?.title || null };
  }
  if (platform === "tiktok") {
    const { body } = await callJson(
      fetchImpl,
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name",
      { headers: { authorization: `Bearer ${token}` } },
      "TikTok"
    );
    return { name: body.data?.user?.display_name || null };
  }
  const fields = platform === "instagram" ? "id,username" : "id,name";
  const { body } = await callJson(
    fetchImpl,
    `${graphBase(config)}/${account.external_account_id}?fields=${fields}&access_token=${encodeURIComponent(token)}`,
    {},
    platform === "instagram" ? "Instagram" : "Facebook"
  );
  return { name: body.username || body.name || null };
}

module.exports = {
  publishLive,
  verifyAccount,
  tiktokCreatorInfo,
  publishYoutube,
  publishFacebook,
  publishInstagram,
  publishTiktok,
  tiktokChunks,
  captionText,
};
