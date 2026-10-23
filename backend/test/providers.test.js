const test = require("node:test");
const assert = require("node:assert/strict");
const { generateConcepts, resolveAi, testAi } = require("../src/providers");

const input = { topic: "นอนหลับ", language: "th", duration_seconds: 45, tone: "friendly", count: 1 };

function withFetch(handler, fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return fn(calls).finally(() => {
    global.fetch = original;
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("resolveAi defaults to local Ollama and ignores a legacy Claude model name", () => {
  const ai = resolveAi({ ai: { provider: "ollama" } }, { model: "claude-sonnet-5-5" });
  assert.equal(ai.provider, "ollama");
  assert.equal(ai.model, "gemma3:4b");
  assert.equal(ai.baseUrl, "http://127.0.0.1:11434");
  assert.equal(ai.apiKey, "");
  assert.equal(resolveAi({}, {}).provider, "mock");
});

test("dashboard provider overrides .env and does not inherit the .env key", () => {
  const ai = resolveAi({ ai: { provider: "groq", apiKey: "gsk_env" } }, { provider: "gemini" }, "saved");
  assert.equal(ai.provider, "gemini");
  assert.equal(ai.apiKey, "saved");
  assert.match(ai.baseUrl, /generativelanguage/);
});

test("Ollama generation uses the native chat API in JSON mode and fills skipped fields", async () => {
  const concept = { hook: "ตื่นมาแล้วยังเพลีย?", script: ["ข้อ 1", "ข้อ 2"], visual_prompt: "bed", caption: "นอนให้ลึก", hashtags: "#นอน #สุขภาพ" };
  await withFetch(
    () => json({ message: { content: JSON.stringify({ concepts: [concept] }) } }),
    async (calls) => {
      const out = await generateConcepts(input, { ai: resolveAi({ ai: { provider: "ollama" } }) });
      assert.equal(calls[0].url, "http://127.0.0.1:11434/api/chat");
      const body = JSON.parse(calls[0].init.body);
      assert.equal(body.format, "json");
      assert.equal(body.stream, false);
      assert.equal(out.provider, "ollama:gemma3:4b");
      assert.equal(out.concepts[0].topic, "นอนหลับ");
      assert.equal(out.concepts[0].script, "ข้อ 1 ข้อ 2");
      assert.deepEqual(out.concepts[0].hashtags.length, 2);
    }
  );
});

test("a missing Ollama model gives the pull command", async () => {
  await withFetch(
    () => json({ error: "model not found" }, 404),
    async () => {
      await assert.rejects(
        generateConcepts(input, { ai: resolveAi({ ai: { provider: "ollama" } }) }),
        (error) => error.code === "AI_MODEL_MISSING" && /ollama pull gemma3:4b/.test(error.message)
      );
    }
  );
});

test("OpenRouter is limited to :free models and hosted free tiers need a key", async () => {
  await withFetch(
    () => json({}),
    async (calls) => {
      const paid = resolveAi({ ai: { provider: "openrouter", apiKey: "k", model: "openai/gpt-5" } });
      await assert.rejects(generateConcepts(input, { ai: paid }), (error) => error.code === "MODEL_NOT_FREE");
      await assert.rejects(testAi(paid), (error) => error.code === "MODEL_NOT_FREE");
      const noKey = resolveAi({ ai: { provider: "groq" } });
      await assert.rejects(generateConcepts(input, { ai: noKey }), (error) => error.code === "NOT_CONFIGURED");
      assert.equal(calls.length, 0, "nothing is sent when the model is not free");
    }
  );
});

test("OpenAI-compatible free tiers send the key and JSON mode", async () => {
  const concept = { topic: "t", hook: "h", script: "s", voice_script: "v", visual_prompt: "p", caption: "c", hashtags: ["#a"], title: "T", cta: "follow", shot_list: "1" };
  await withFetch(
    () => json({ choices: [{ message: { content: "```json\n" + JSON.stringify({ concepts: [concept] }) + "\n```" } }] }),
    async (calls) => {
      const out = await generateConcepts(input, { ai: resolveAi({ ai: { provider: "groq", apiKey: "gsk_test" } }) });
      assert.equal(calls[0].url, "https://api.groq.com/openai/v1/chat/completions");
      assert.equal(calls[0].init.headers.authorization, "Bearer gsk_test");
      assert.deepEqual(JSON.parse(calls[0].init.body).response_format, { type: "json_object" });
      assert.equal(out.concepts[0].title, "T");
    }
  );
});

test("testAi reports an Ollama model that is not pulled", async () => {
  await withFetch(
    () => json({ models: [{ name: "qwen2.5:1.5b" }] }),
    async () => {
      await assert.rejects(testAi(resolveAi({ ai: { provider: "ollama" } })), (error) => error.code === "AI_MODEL_MISSING");
      const ok = await testAi(resolveAi({ ai: { provider: "ollama", model: "qwen2.5:1.5b" } }));
      assert.equal(ok.status, "ok");
    }
  );
});
