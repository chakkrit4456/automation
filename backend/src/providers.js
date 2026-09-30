const { renderShortVideo } = require("./media");
const { validateAiOutput, accountIsExpired, httpError } = require("./domain");

const SYSTEM_PROMPT = `You are the content planning engine for a short-form social media automation system.
Your job is to generate useful, original, non-spammy short-form content.
Return valid JSON only.
Do not invent product claims, make medical or legal guarantees, repeat the same hook, generate deceptive engagement bait, or use unsupported statistics.
Respect the target language, duration, tone, niche, and platform constraints.
Output fields: topic, hook, script, voice_script, visual_prompt, caption, hashtags, title, cta, shot_list.`;

function mockConcept(input, index) {
  const language = input.language || "th";
  const thai = language === "th" || language === "ไทย";
  const title = thai
    ? `${input.topic}${index ? ` · แนว ${index + 1}` : ""}`
    : `${input.topic}${index ? ` · idea ${index + 1}` : ""}`;
  const hook = thai
    ? `${input.topic} — เริ่มที่ 2 วินาทีแรก`
    : `${input.topic} — open in the first 2 seconds`;
  const points = thai
    ? "1. บอกปัญหาให้ชัดในประโยคแรก 2. ให้ขั้นตอนที่ทำได้วันนี้ 3. ปิดด้วยสิ่งที่ผู้ชมได้"
    : "1. Name the problem in the first line 2. Give a step someone can do today 3. Close with the payoff";
  return validateAiOutput({
    topic: input.topic,
    title,
    hook,
    script: points,
    voice_script: thai ? `${hook} ${points}` : `${hook}. ${points}`,
    visual_prompt: "vertical 9:16, flat illustration, clear subject, no unsupported claims",
    shot_list: thai
      ? "1. ภาพเปิดปัญหา 2. ขั้นตอนที่หนึ่ง 3. ขั้นตอนที่สอง 4. ปิดท้ายด้วย CTA"
      : "1. Problem frame 2. First step 3. Second step 4. CTA",
    caption: thai ? `${input.topic} เริ่มได้วันนี้` : `${input.topic}. Start today.`,
    hashtags: thai ? ["#ความรู้สั้น", "#ทำได้จริง"] : ["#shorts", "#howto"],
    cta: input.cta || (thai ? "กดติดตามเพื่อดูตอนต่อไป" : "Follow for the next one"),
  });
}

async function generateConcepts(input, options) {
  const recent = options.recent || [];
  if (!options.apiKey) {
    return {
      provider: "mock",
      concepts: Array.from({ length: input.count }, (_, index) => mockConcept(input, index)),
    };
  }
  const recentText = recent
    .slice(0, 12)
    .map((row) => `- ${row.topic} / ${row.hook || ""}`)
    .join("\n");
  const user = `Generate ${input.count} distinct concepts as a JSON array.
Topic: ${input.topic}
Niche: ${input.niche || "general"}
Language: ${input.language}
Duration seconds: ${input.duration_seconds}
Tone: ${input.tone}
Style: ${input.style || "clear"}
CTA: ${input.cta || ""}
Audience: ${input.target_audience || "general"}
Recent content to avoid repeating:
${recentText || "(none)"}
Return JSON only: {"concepts":[...]} with fields topic, hook, script, voice_script, visual_prompt, caption, hashtags, title, cta, shot_list.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": options.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: options.model || "claude-sonnet-5-5",
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: user }],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || "Claude API request failed";
    throw httpError(502, "AI_UPSTREAM", message);
  }
  const text = (payload.content || []).map((block) => block.text || "").join("\n");
  const json = extractJson(text);
  const concepts = Array.isArray(json) ? json : json.concepts;
  if (!Array.isArray(concepts) || !concepts.length) {
    throw httpError(502, "AI_INVALID", "Model did not return concepts");
  }
  return {
    provider: "claude",
    concepts: concepts.slice(0, input.count).map((item) => validateAiOutput(item)),
  };
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.search(/[\[{]/);
  if (start < 0) throw httpError(502, "AI_INVALID", "Model output was not JSON");
  return JSON.parse(raw.slice(start));
}

async function generateVideo(content, options) {
  const rendered = await renderShortVideo(content, {
    mediaRoot: options.mediaRoot,
    tts: options.tts,
    font: options.font,
    fontsDir: options.fontsDir,
  });
  if (rendered.ok) {
    const voiced = rendered.tts.ok;
    return {
      provider: "ffmpeg",
      status: "READY",
      storage_path: rendered.storage_path,
      mime_type: "video/mp4",
      width: rendered.width,
      height: rendered.height,
      fps: rendered.fps,
      duration_seconds: rendered.duration_seconds,
      file_size: rendered.file_size,
      audio_status: voiced ? "READY" : "SILENT",
      subtitle_status: "BURNED",
      pipeline: {
        script: "DONE",
        tts: voiced ? "DONE" : rendered.tts.skipped ? "SKIPPED" : "FAILED",
        visuals: "GRADIENT",
        ffmpeg: "DONE",
        subtitles: "DONE",
      },
      note: voiced ? null : `No narration: ${rendered.tts.error || "TTS disabled"}`,
    };
  }
  if (!rendered.missing) {
    throw httpError(500, "VIDEO_FAILED", `FFmpeg failed: ${rendered.error || "unknown error"}`);
  }
  return {
    provider: "mock",
    status: "READY",
    storage_path: null,
    mime_type: "video/mp4",
    width: 1080,
    height: 1920,
    fps: 30,
    duration_seconds: Number(content.duration_seconds || 45),
    file_size: null,
    audio_status: "PENDING",
    subtitle_status: "PENDING",
    pipeline: { script: "DONE", tts: "SKIPPED", visuals: "SKIPPED", ffmpeg: "SKIPPED", subtitles: "SKIPPED" },
    note: "FFmpeg is not installed. No MP4 was rendered. Install FFmpeg to render a real file.",
  };
}

function publishDecision(account, mode) {
  if (!account || account.status === "DISCONNECTED") {
    return { ok: false, code: "NOT_CONNECTED", message: "Account is not connected", permanent: true };
  }
  if (accountIsExpired(account)) {
    return { ok: false, code: "OAUTH_EXPIRED", message: "OAuth token expired", permanent: true };
  }
  if (mode === "live") {
    return {
      ok: false,
      code: "MANUAL_APPROVAL",
      message: "Live publishing uses the official API after the developer app is approved. No upload was sent.",
      permanent: true,
    };
  }
  return { ok: true, external_id: `mock-${account.platform}-${Date.now()}` };
}

module.exports = {
  SYSTEM_PROMPT,
  generateConcepts,
  generateVideo,
  publishDecision,
  extractJson,
};
