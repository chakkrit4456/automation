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

// Free text models only. "ollama" runs on this server (no key, no cost). The others are
// free tiers of hosted APIs and need a free key; OpenRouter is limited to its ":free" models.
const AI_PRESETS = {
  ollama: { label: "Ollama (local)", baseUrl: "http://127.0.0.1:11434", model: "gemma3:4b", needsKey: false },
  groq: { label: "Groq free tier", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", needsKey: true, jsonMode: true },
  gemini: { label: "Google Gemini free tier", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash", needsKey: true, jsonMode: true },
  openrouter: { label: "OpenRouter free models", baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", needsKey: true },
  mock: { label: "Mock (offline)", baseUrl: "", model: "mock", needsKey: false },
};

// Combine the server .env (config.ai) with the dashboard AI settings into one call target.
// apiKey is the key saved from the dashboard (already decrypted), used when .env has none.
function resolveAi(config, settings = {}, savedKey = "") {
  const env = config?.ai || {};
  const envProvider = AI_PRESETS[env.provider] ? env.provider : "mock";
  const provider = AI_PRESETS[settings.provider] ? settings.provider : envProvider;
  const preset = AI_PRESETS[provider];
  const sameAsEnv = provider === envProvider;
  // Older installs stored a Claude model name in settings; it means nothing to a free provider.
  const savedModel = settings.model && !/^claude/i.test(settings.model) ? settings.model : "";
  return {
    provider,
    model: savedModel || (sameAsEnv && env.model) || preset.model,
    baseUrl: ((sameAsEnv && env.baseUrl) || preset.baseUrl).replace(/\/+$/, ""),
    apiKey: (sameAsEnv && env.apiKey) || savedKey || "",
    timeoutMs: Number(env.timeoutMs) || 300_000,
  };
}

function assertFreeModel(ai) {
  if (ai.provider === "openrouter" && !String(ai.model).endsWith(":free")) {
    throw httpError(400, "MODEL_NOT_FREE", `OpenRouter model must end with ":free" (got ${ai.model})`);
  }
  if (AI_PRESETS[ai.provider]?.needsKey && !ai.apiKey) {
    throw httpError(400, "NOT_CONFIGURED", `${AI_PRESETS[ai.provider].label} needs a free API key (AI_API_KEY)`);
  }
}

async function generateConcepts(input, options) {
  const recent = options.recent || [];
  const ai = options.ai || { provider: "mock" };
  if (ai.provider === "mock" || !AI_PRESETS[ai.provider]) {
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
Return JSON only: {"concepts":[...]} with fields topic, hook, script, voice_script, visual_prompt, caption, hashtags (array of strings), title, cta, shot_list.`;

  assertFreeModel(ai);
  const text = await chat(ai, SYSTEM_PROMPT, user);
  const json = extractJson(text);
  const concepts = Array.isArray(json) ? json : json.concepts || (json.hook ? [json] : null);
  if (!Array.isArray(concepts) || !concepts.length) {
    throw httpError(502, "AI_INVALID", "Model did not return concepts");
  }
  return {
    provider: `${ai.provider}:${ai.model}`,
    concepts: concepts.slice(0, input.count).map((item) => validateAiOutput(normalizeConcept(item, input))),
  };
}

// Small local models sometimes return lists where strings are expected, or skip easy fields.
function normalizeConcept(item, input) {
  const out = { ...(item || {}) };
  for (const key of ["script", "voice_script", "shot_list", "visual_prompt", "caption"]) {
    if (Array.isArray(out[key])) out[key] = out[key].join(" ");
  }
  out.topic = out.topic || input.topic;
  out.title = out.title || out.topic;
  out.voice_script = out.voice_script || [out.hook, out.script].filter(Boolean).join(" ");
  out.cta = out.cta || input.cta || out.caption;
  return out;
}

async function chat(ai, system, user) {
  const label = AI_PRESETS[ai.provider].label;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  // Ollama uses its native API so the context window and JSON mode can be set per request.
  const request = ai.provider === "ollama"
    ? {
        url: `${ai.baseUrl}/api/chat`,
        headers: {},
        body: { model: ai.model, stream: false, format: "json", options: { temperature: 0.8, num_ctx: 8192 }, messages },
      }
    : {
        url: `${ai.baseUrl}/chat/completions`,
        headers: { authorization: `Bearer ${ai.apiKey}` },
        body: {
          model: ai.model,
          temperature: 0.8,
          max_tokens: 4000,
          ...(AI_PRESETS[ai.provider].jsonMode ? { response_format: { type: "json_object" } } : {}),
          messages,
        },
      };
  const response = await fetch(request.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...request.headers },
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(ai.timeoutMs || 300_000),
  }).catch((error) => {
    const reason = error.name === "TimeoutError" ? "timed out" : error.message;
    throw httpError(502, "AI_UPSTREAM", `Could not reach ${label} at ${ai.baseUrl}: ${reason}`);
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (ai.provider === "ollama" && response.status === 404) {
      throw httpError(502, "AI_MODEL_MISSING", `Ollama model ${ai.model} is not pulled. Run: ollama pull ${ai.model}`);
    }
    const message = payload?.error?.message || payload?.error || `HTTP ${response.status}`;
    throw httpError(502, "AI_UPSTREAM", `${label}: ${message}`);
  }
  return ai.provider === "ollama" ? payload.message?.content || "" : payload.choices?.[0]?.message?.content || "";
}

// Connection check behind the dashboard "test" button.
async function testAi(ai) {
  if (ai.provider === "mock") return { status: "ok", note: "Mock generator: no AI calls." };
  assertFreeModel(ai);
  const label = AI_PRESETS[ai.provider].label;
  const url = ai.provider === "ollama" ? `${ai.baseUrl}/api/tags` : `${ai.baseUrl}/models`;
  const headers = ai.apiKey ? { authorization: `Bearer ${ai.apiKey}` } : {};
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!response) throw httpError(502, "AI_UPSTREAM", `Could not reach ${label} at ${ai.baseUrl}`);
  if (response.status === 401 || response.status === 403) throw httpError(400, "AI_KEY_INVALID", `${label} rejected the API key`);
  if (!response.ok) throw httpError(502, "AI_UPSTREAM", `${label} returned HTTP ${response.status}`);
  if (ai.provider === "ollama") {
    const names = ((await response.json().catch(() => ({}))).models || []).map((row) => row.name);
    if (!names.includes(ai.model) && !names.includes(`${ai.model}:latest`)) {
      throw httpError(400, "AI_MODEL_MISSING", `Ollama is running but ${ai.model} is not pulled. Run: ollama pull ${ai.model}`);
    }
  }
  return { status: "ok", note: `${label} ready (${ai.model}). Free model, no paid API.` };
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
  AI_PRESETS,
  resolveAi,
  testAi,
  generateConcepts,
  generateVideo,
  publishDecision,
  extractJson,
};
