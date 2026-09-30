const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const PALETTES = [
  ["0x0f2027", "0x2c5364"],
  ["0x1e3a5f", "0x5980a6"],
  ["0x3a1c71", "0xd76d77"],
  ["0x134e5e", "0x71b280"],
  ["0x232526", "0x414345"],
];

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, cwd: options.cwd, env: options.env ? { ...process.env, ...options.env } : process.env });
    } catch {
      resolve({ ok: false, missing: true, stdout: "", error: `${command} not available` });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs || 10 * 60_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, missing: true, stdout, error: `${command} not available` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, error: code === 0 ? null : stderr.slice(-800) });
    });
  });
}

async function probeDuration(file) {
  const result = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const value = Number(result.stdout.trim());
  return result.ok && Number.isFinite(value) && value > 0 ? value : null;
}

function isThai(text) {
  return /[฀-๿]/.test(text);
}

// Split narration into short caption lines. Thai has no spaces between words,
// so Intl.Segmenter finds word boundaries before we pack words into lines.
function captionChunks(text, maxChars) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const limit = maxChars || (isThai(clean) ? 28 : 38);
  const segmenter = new Intl.Segmenter(isThai(clean) ? "th" : "en", { granularity: "word" });
  const chunks = [];
  let line = "";
  const flush = () => {
    const value = line.trim();
    if (value) chunks.push(value);
    line = "";
  };
  for (const { segment } of segmenter.segment(clean)) {
    if (line.length + segment.length > limit && line.trim()) {
      // Prefer breaking at the last space so a phrase stays on one line.
      const cut = line.lastIndexOf(" ");
      if (cut >= line.length * 0.4) {
        const rest = line.slice(cut + 1);
        line = line.slice(0, cut);
        flush();
        line = rest;
      } else {
        flush();
      }
    }
    line += segment;
    if (/[.!?。…]\s*$|[.!?]$/.test(segment) || /^[.!?]$/.test(segment.trim())) flush();
  }
  flush();
  return chunks;
}

function timeline(chunks, duration, lead = 0.2) {
  const usable = Math.max(duration - lead - 0.3, 0.5);
  const weights = chunks.map((chunk) => Math.max(chunk.length, 4));
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  let cursor = lead;
  return chunks.map((text, index) => {
    const span = (weights[index] / total) * usable;
    const start = cursor;
    cursor += span;
    return { text, start, end: cursor };
  });
}

function assTime(seconds) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const rest = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(rest).padStart(2, "0")}`;
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

function assEscape(text) {
  return String(text || "")
    .replace(/[{}]/g, "")
    .replace(/\\/g, "")
    .replace(/\r?\n/g, "\\N");
}

function wrapHook(text) {
  const chunks = captionChunks(text, isThai(text) ? 16 : 26);
  return chunks.slice(0, 4).join("\\N");
}

function buildAss({ hook, cues, duration, font }) {
  const face = font || "Noto Sans Thai";
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${WIDTH}`,
    `PlayResY: ${HEIGHT}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Hook,${face},86,&H0000E1FF,&H000000FF,&H00101010,&H78000000,-1,0,0,0,100,100,0,0,1,6,3,8,70,70,260,1`,
    `Style: Sub,${face},74,&H00FFFFFF,&H000000FF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,1,6,2,2,80,80,480,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  if (hook) {
    lines.push(`Dialogue: 1,${assTime(0)},${assTime(duration)},Hook,,0,0,0,,${wrapHook(assEscape(hook))}`);
  }
  for (const cue of cues) {
    lines.push(`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Sub,,0,0,0,,${assEscape(cue.text)}`);
  }
  return `${lines.join("\n")}\n`;
}

function buildSrt(cues) {
  return cues
    .map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`)
    .join("\n");
}

async function synthesize(text, file, tts) {
  const provider = (tts.provider || "edge").toLowerCase();
  if (provider === "none" || !String(text || "").trim()) return { ok: false, skipped: true };
  const textFile = `${file}.txt`;
  fs.writeFileSync(textFile, text, "utf8");
  const args = ["--voice", tts.voice || "th-TH-PremwadeeNeural", "--file", textFile, "--write-media", file];
  if (tts.rate) args.push(`--rate=${tts.rate}`);
  let result;
  // Python on Windows reads files in the ANSI code page unless UTF-8 mode is on, which garbles Thai.
  const env = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
  // The Edge TTS service drops a request now and then, so try twice.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    result = await run(tts.command || "edge-tts", args, { timeoutMs: 120_000, env });
    if (result.missing && !tts.command) {
      result = await run("python3", ["-m", "edge_tts", ...args], { timeoutMs: 120_000, env });
      if (result.missing) result = await run("python", ["-m", "edge_tts", ...args], { timeoutMs: 120_000, env });
    }
    if (result.ok || result.missing) break;
  }
  fs.rmSync(textFile, { force: true });
  if (!result.ok || !fs.existsSync(file) || fs.statSync(file).size === 0) {
    const lastLine = String(result.error || "").trim().split(/\r?\n/).pop();
    return { ok: false, error: lastLine || "TTS produced no audio" };
  }
  return { ok: true };
}

function paletteFor(id) {
  const sum = [...String(id || "")].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return PALETTES[sum % PALETTES.length];
}

let videoLock = Promise.resolve();

function withVideoLock(fn) {
  const next = videoLock.then(fn, fn);
  videoLock = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function renderShortVideo(content, options) {
  return withVideoLock(async () => {
    const root = options.mediaRoot;
    const stamp = Date.now();
    const work = path.join(root, "work", `${content.id}-${stamp}`);
    fs.mkdirSync(work, { recursive: true });
    const output = path.join(root, `${content.id}-${stamp}.mp4`);
    const narration = [content.voice_script || content.script || content.hook, content.voice_script ? "" : content.cta]
      .filter(Boolean)
      .join(" ");
    const tts = options.tts || {};
    const audioFile = path.join(work, "voice.mp3");
    const voice = await synthesize(narration, audioFile, tts);
    const audioDuration = voice.ok ? await probeDuration(audioFile) : null;
    const target = Number(content.duration_seconds || 30);
    const duration = Math.min(Math.max(audioDuration ? audioDuration + 0.6 : target, 5), 180);

    const cues = timeline(captionChunks(narration), audioDuration || duration);
    fs.writeFileSync(path.join(work, "subs.ass"), buildAss({ hook: content.hook, cues, duration, font: options.font }), "utf8");
    const srtPath = output.replace(/\.mp4$/, ".srt");
    fs.writeFileSync(srtPath, buildSrt(cues), "utf8");

    const [c0, c1] = paletteFor(content.id);
    const fontsDir = options.fontsDir ? `:fontsdir='${options.fontsDir.replace(/\\/g, "/").replace(/:/g, "\\:")}'` : "";
    const args = [
      "-y",
      "-f",
      "lavfi",
      "-i",
      // Draw the gradient at quarter size and scale up: about 3x faster on a small CPU.
      `gradients=s=${WIDTH / 4}x${HEIGHT / 4}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=${WIDTH / 4}:y1=${HEIGHT / 4}:speed=0.008:r=${FPS}:d=${duration.toFixed(2)}`,
    ];
    if (voice.ok) args.push("-i", "voice.mp3");
    else args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
    args.push(
      "-vf",
      `scale=${WIDTH}:${HEIGHT}:flags=bicubic,subtitles=subs.ass${fontsDir}`,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-t",
      duration.toFixed(2),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "44100",
      "-movflags",
      "+faststart",
      output
    );
    const ffmpeg = await run("ffmpeg", args, { cwd: work, timeoutMs: 15 * 60_000 });
    fs.rmSync(work, { recursive: true, force: true });
    if (!ffmpeg.ok) {
      fs.rmSync(srtPath, { force: true });
      return { ok: false, missing: ffmpeg.missing, error: ffmpeg.error, tts: voice };
    }
    return {
      ok: true,
      storage_path: output,
      subtitle_path: srtPath,
      duration_seconds: Math.round(duration * 10) / 10,
      file_size: fs.statSync(output).size,
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      tts: voice,
    };
  });
}

module.exports = {
  captionChunks,
  timeline,
  buildAss,
  buildSrt,
  renderShortVideo,
  probeDuration,
};
