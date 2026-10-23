#!/usr/bin/env node
// Create .env from .env.example with fresh random secrets.
//   node scripts/make-env.js           production defaults (Docker / Debian)
//   node scripts/make-env.js --local   local development on this machine
// Refuses to overwrite an existing .env unless --force is given.
const fs = require("fs");
const path = require("path");
const { randomBytes } = require("crypto");

const root = path.resolve(__dirname, "..");
const target = path.join(root, ".env");
const args = new Set(process.argv.slice(2));

if (fs.existsSync(target) && !args.has("--force")) {
  console.error(".env already exists. Use --force to replace it.");
  process.exit(1);
}

let text = fs.readFileSync(path.join(root, ".env.example"), "utf8");
text = text.replace(/CHANGE_ME_TO_A_LONG_RANDOM_(SECRET|PASSWORD)/g, () => randomBytes(24).toString("hex"));

function set(key, value) {
  const line = new RegExp(`^${key}=.*$`, "m");
  text = line.test(text) ? text.replace(line, `${key}=${value}`) : `${text}\n${key}=${value}\n`;
}

if (args.has("--local")) {
  set("NODE_ENV", "development");
  set("PUBLIC_URL", "http://localhost:5173");
  set("MEDIA_ROOT", "");
  set("SEED_DEMO", "true");
  if (process.platform === "win32") set("SUBTITLE_FONT", "\"Leelawadee UI\"");
}

fs.writeFileSync(target, text, { mode: 0o600 });
console.log(`Wrote ${target}`);
console.log("Admin login: ADMIN_EMAIL / ADMIN_PASSWORD in .env. AI uses free models (AI_PROVIDER=ollama by default). Add OAuth credentials next.");
