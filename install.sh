#!/usr/bin/env bash
# =============================================================================
#  AI Social Automation — ตัวติดตั้งแบบไม่ใช้ Docker
#  สำหรับ: Debian 13 (trixie) standard — รองรับ Debian 12 / TurnKey Node.js ด้วย
#
#  ติดตั้งให้ครบ: Node.js 24, PostgreSQL, FFmpeg + ฟอนต์ไทย, edge-tts,
#  Ollama + โมเดล AI ฟรี (รันบนเครื่องนี้ ไม่มีค่า API), n8n, Nginx (reverse proxy),
#  systemd services, HTTPS (ถ้าใส่โดเมน)
#
#  วิธีใช้ (ในโฟลเดอร์โปรเจคบนเซิร์ฟเวอร์, รันด้วย root):
#     bash install.sh
#  หรือกำหนดค่าล่วงหน้า:
#     DOMAIN=app.example.com N8N_DOMAIN=n8n.example.com LE_EMAIL=me@example.com bash install.sh
#
#  ตัวแปรที่ปรับได้ (ไม่ใส่ก็ได้):
#     DOMAIN        โดเมนของหน้า dashboard (ค่าเริ่มต้น automation.itdev.in.th)
#     N8N_DOMAIN    โดเมนของ n8n (ไม่ใส่ = n8n ฟังเฉพาะ 127.0.0.1:5678)
#     LE_EMAIL      อีเมลสำหรับ Let's Encrypt (ต้องมีพร้อม DOMAIN จึงจะขอ HTTPS)
#     INSTALL_N8N   yes/no  (ค่าเริ่มต้น yes)
#     APP_DIR       ที่ติดตั้ง (ค่าเริ่มต้น /opt/ai-social)
#     APP_PORT      พอร์ตภายในของแอป (ค่าเริ่มต้น 3000)
#     CF_TUNNEL     yes = อยู่หลัง Cloudflare Tunnel (HTTPS จัดการโดย Cloudflare, ไม่ใช้ certbot)
#                   ค่าเริ่มต้น = existing (ใช้ tunnel เดิมที่ route มาที่ IP เครื่องนี้ ไม่ติดตั้ง cloudflared)
#                   yes = ติดตั้ง cloudflared บนเครื่องนี้, no = ไม่ใช้ Cloudflare
#     CF_TUNNEL_TOKEN  (ไม่บังคับ) token ของ tunnel ที่สร้างไว้ใน Dashboard ถ้าไม่ใส่ สคริปต์จะให้ล็อกอิน
#                   Cloudflare ผ่านเบราว์เซอร์ครั้งเดียว แล้วสร้าง tunnel + DNS ให้อัตโนมัติ
#     CF_TUNNEL_NAME   ชื่อ tunnel ที่จะสร้าง (ค่าเริ่มต้น ai-social)
#
#     ALERT_WEBHOOK_URL  Discord/Slack webhook สำหรับแจ้งเตือนเมื่อแอปล่ม/สำรองข้อมูลล้มเหลว (ไม่ใส่ก็ได้)
#     ENABLE_UFW    yes/no  เปิด firewall (ค่าเริ่มต้น yes; ข้ามเองถ้าหาพอร์ต SSH ไม่เจอ)
#     SWAP_MB       ขนาด swap ที่จะสร้างถ้ายังไม่มี swap และ RAM <= 8 GB (มี Ollama) / 3 GB (ค่าเริ่มต้น 4096)
#     BACKUP_MEDIA  yes = สำรองโฟลเดอร์วิดีโอด้วย (ค่าเริ่มต้น no เพราะไฟล์ใหญ่)
#
#     AI (ฟรี 100%):
#     AI_PROVIDER   ollama (ค่าเริ่มต้น, รันบนเครื่องนี้) | groq | gemini | openrouter (free tier, ต้องมีคีย์ฟรี) | mock
#     AI_MODEL      ชื่อโมเดล (ไม่ใส่ = เลือกตาม RAM: < 6 GB → qwen2.5:1.5b, ไม่งั้น gemma3:4b)
#     AI_API_KEY    คีย์ฟรีของ groq / gemini / openrouter (ollama ไม่ต้องใช้)
#     INSTALL_OLLAMA yes/no  (ค่าเริ่มต้น yes เมื่อ AI_PROVIDER=ollama)
#
#  ตัวอย่าง Cloudflare Tunnel:
#     bash install.sh                      # ใช้ค่าเริ่มต้น (automation.itdev.in.th) ไม่ต้องมี token
#     CF_TUNNEL_TOKEN=eyJ... bash install.sh   # ถ้ามี token อยู่แล้ว
#
#  รันซ้ำได้เพื่ออัปเดตโค้ด: .env และฐานข้อมูลเดิมจะถูกเก็บไว้
# =============================================================================
set -Eeuo pipefail

# ---------- ค่าตั้งต้น ----------
APP_NAME="ai-social"
APP_USER="aisocial"
APP_DIR="${APP_DIR:-/opt/ai-social}"
APP_PORT="${APP_PORT:-3000}"
N8N_PORT="${N8N_PORT:-5678}"
DOMAIN="${DOMAIN:-automation.itdev.in.th}"
N8N_DOMAIN="${N8N_DOMAIN:-}"
LE_EMAIL="${LE_EMAIL:-}"
INSTALL_N8N="${INSTALL_N8N:-yes}"
CF_TUNNEL_TOKEN="${CF_TUNNEL_TOKEN:-}"
# CF_TUNNEL: existing = มี tunnel อยู่แล้วที่เครื่องอื่น/Dashboard ชี้มาที่เครื่องนี้ (ค่าเริ่มต้น, ไม่ติดตั้ง cloudflared)
#            yes      = ติดตั้ง cloudflared บนเครื่องนี้ (ใช้ token หรือล็อกอินผ่านเบราว์เซอร์)
#            no       = ไม่ใช้ Cloudflare (ใช้ certbot ถ้าใส่ LE_EMAIL)
CF_TUNNEL="${CF_TUNNEL:-$([[ -n "$CF_TUNNEL_TOKEN" ]] && echo yes || { [[ -n "$LE_EMAIL" ]] && echo no || echo existing; })}"
BEHIND_CF=$([[ "$CF_TUNNEL" == yes || "$CF_TUNNEL" == existing ]] && echo yes || echo no)
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
ENABLE_UFW="${ENABLE_UFW:-yes}"
SWAP_MB="${SWAP_MB:-4096}"
BACKUP_MEDIA="${BACKUP_MEDIA:-no}"
AI_PROVIDER_IN="${AI_PROVIDER:-}"
AI_MODEL_IN="${AI_MODEL:-}"
AI_API_KEY_IN="${AI_API_KEY:-}"
INSTALL_OLLAMA="${INSTALL_OLLAMA:-}"
NODE_MAJOR=24   # n8n 2.x ต้องการ Node >= 24 (backend ต้องการ >= 22.9)
DB_NAME="ai_social"
DB_USER="ai_social"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$APP_DIR/.env"
LOG_FILE="/var/log/${APP_NAME}-install.log"

# ---------- helpers ----------
c_ok="\033[1;32m"; c_info="\033[1;36m"; c_warn="\033[1;33m"; c_err="\033[1;31m"; c_off="\033[0m"
step() { echo -e "\n${c_info}==> $*${c_off}"; }
ok()   { echo -e "${c_ok}  ✓ $*${c_off}"; }
warn() { echo -e "${c_warn}  ! $*${c_off}"; }
die()  { echo -e "${c_err}  ✗ $*${c_off}" >&2; exit 1; }
trap 'die "ติดตั้งล้มเหลวที่บรรทัด $LINENO (ดู log: $LOG_FILE)"' ERR
rand() { openssl rand -hex "${1:-24}"; }

# env_set KEY VALUE  -> เขียนหรือแทนที่ค่าใน .env
env_set() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${val//|/\\|}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}
env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
# ถ้าค่ายังเป็น placeholder/ว่าง ให้สุ่มใหม่
env_secret() {
  local cur; cur="$(env_get "$1")"
  if [[ -z "$cur" || "$cur" == CHANGE_ME* ]]; then env_set "$1" "$(rand 24)"; fi
}

# ---------- ตรวจสอบเบื้องต้น ----------
[[ $EUID -eq 0 ]] || die "กรุณารันด้วย root (bash install.sh)"
[[ -f "$SRC_DIR/backend/server.js" && -f "$SRC_DIR/database/schema.sql" ]] \
  || die "ให้วาง install.sh ไว้ที่โฟลเดอร์รากของโปรเจค (ที่มี backend/ frontend/ database/)"
. /etc/os-release
case "${VERSION_CODENAME:-}" in
  trixie|bookworm) ;;
  *) warn "ออกแบบสำหรับ Debian 13 (trixie) / Debian 12 (bookworm) แต่พบ ${PRETTY_NAME:-unknown}" ;;
esac
exec > >(tee -a "$LOG_FILE") 2>&1
export DEBIAN_FRONTEND=noninteractive

echo "============================================================"
echo " AI Social Automation — native install (no Docker)"
echo " Source : $SRC_DIR"
echo " Target : $APP_DIR"
echo " Domain : ${DOMAIN:-<ใช้ IP>}   n8n: ${N8N_DOMAIN:-<localhost only>}"
echo "============================================================"

# n8n ใช้ราว 3 GB และโมเดล AI อีก 1-4 GB — ถ้าดิสก์เต็ม npm/ollama จะล้มกลางทาง (ENOSPC)
free_mb="$(df -Pm / | awk 'NR==2{print $4}')"
if [[ "$free_mb" -lt 8192 ]]; then
  warn "พื้นที่ดิสก์ว่างเหลือ ${free_mb} MB (แนะนำ >= 8 GB) — ล้าง cache ให้ก่อน"
  apt-get clean || true
  npm cache clean --force >/dev/null 2>&1 || true
  journalctl --vacuum-size=100M >/dev/null 2>&1 || true
  free_mb="$(df -Pm / | awk 'NR==2{print $4}')"
  [[ "$free_mb" -lt 1024 ]] && die "ดิสก์ว่างเหลือแค่ ${free_mb} MB — ขยายดิสก์ก่อน (แนะนำ >= 16 GB)"
fi

# ---------- 1. แพ็กเกจระบบ ----------
step "1/11 ติดตั้งแพ็กเกจระบบ"
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg openssl rsync git build-essential \
  iproute2 procps zstd pciutils \
  nginx postgresql \
  ffmpeg fonts-noto-core fonts-thai-tlwg fontconfig \
  python3 python3-venv python3-pip \
  certbot python3-certbot-nginx
fc-cache -f >/dev/null || true
ok "แพ็กเกจระบบพร้อม"

# ---------- 2. Node.js 24 (TurnKey มาพร้อม 18; backend ต้องการ >=22.9, n8n 2.x ต้องการ >=24) ----------
step "2/11 ติดตั้ง Node.js ${NODE_MAJOR}"
cur_major="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)"
if [[ "${cur_major:-0}" -lt "$NODE_MAJOR" ]]; then
  warn "พบ Node $(node -v 2>/dev/null || echo 'none') — อัปเกรดเป็น ${NODE_MAJOR}.x จาก NodeSource"
  # ปิด service node เดิมของ TurnKey (ถ้ามี) เพื่อไม่ให้แย่งพอร์ต
  for s in nodejs node-app pm2-root; do systemctl disable --now "$s" 2>/dev/null || true; done
  command -v pm2 >/dev/null && { pm2 kill >/dev/null 2>&1 || true; }
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  # ลบ node เก่าที่อาจติดตั้งแบบ manual ไว้ใน /usr/local
  [[ -x /usr/local/bin/node ]] && mv /usr/local/bin/node /usr/local/bin/node.old-turnkey || true
  apt-get update -y
  apt-get install -y nodejs
  hash -r
fi
NODE_BIN="$(command -v node)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>=24?0:1)' \
  || die "ต้องการ Node >= 24 แต่ได้ $(node -v)"
ok "Node $(node -v), npm $(npm -v)"

# ---------- 3. ผู้ใช้ระบบ + คัดลอกโค้ด ----------
step "3/11 สร้างผู้ใช้ '$APP_USER' และคัดลอกโค้ดไป $APP_DIR"
id "$APP_USER" &>/dev/null || useradd --system --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR" /var/lib/$APP_NAME/media
if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  rsync -a --delete \
    --exclude '.git' --exclude 'node_modules' --exclude '.env' --exclude '.venv' \
    --exclude '_mockups' --exclude 'data' --exclude 'frontend/dist' \
    "$SRC_DIR/" "$APP_DIR/"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
ok "โค้ดอยู่ที่ $APP_DIR"

# ---------- 4. edge-tts (Python venv) ----------
step "4/11 ติดตั้ง edge-tts (เสียงพากย์ไทยฟรี)"
if [[ ! -x "$APP_DIR/.venv/bin/edge-tts" ]]; then
  runuser -u "$APP_USER" -- python3 -m venv "$APP_DIR/.venv"
fi
runuser -u "$APP_USER" -- "$APP_DIR/.venv/bin/pip" install --quiet --upgrade pip edge-tts
ln -sf "$APP_DIR/.venv/bin/edge-tts" /usr/local/bin/edge-tts
ok "edge-tts $("$APP_DIR/.venv/bin/edge-tts" --version 2>/dev/null | head -1 || echo installed)"

# ---------- 5. AI ฟรี: Ollama + โมเดล open-weight (ไม่มีค่า API) ----------
mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
# ค่าใน .env เดิมมาก่อนค่า default (รันซ้ำเพื่ออัปเดตจะไม่เปลี่ยนโมเดลเอง)
AI_PROVIDER="${AI_PROVIDER_IN:-$(env_get AI_PROVIDER || true)}"; AI_PROVIDER="${AI_PROVIDER:-ollama}"
AI_MODEL="${AI_MODEL_IN:-$(env_get AI_MODEL || true)}"
if [[ -z "$AI_MODEL" && "$AI_PROVIDER" == ollama ]]; then
  if [[ "$mem_kb" -lt 6291456 ]]; then AI_MODEL="qwen2.5:1.5b"; else AI_MODEL="gemma3:4b"; fi
fi
INSTALL_OLLAMA="${INSTALL_OLLAMA:-$([[ "$AI_PROVIDER" == ollama ]] && echo yes || echo no)}"
step "5/11 ติดตั้ง AI ฟรี (${AI_PROVIDER}${AI_MODEL:+ / $AI_MODEL})"
if [[ "$INSTALL_OLLAMA" == yes ]]; then
  if ! command -v ollama >/dev/null; then
    # ตัวติดตั้งทางการของ Ollama: สร้างผู้ใช้ ollama + systemd service และตรวจ GPU ให้เอง
    curl -fsSL https://ollama.com/install.sh -o /tmp/ollama-install.sh
    sh /tmp/ollama-install.sh
    rm -f /tmp/ollama-install.sh
  fi
  # ฟังเฉพาะ localhost, โหลดโมเดลทีละตัว (เครื่องเล็ก), context พอสำหรับหลายไอเดียต่อครั้ง
  install -d /etc/systemd/system/ollama.service.d
  cat > /etc/systemd/system/ollama.service.d/ai-social.conf <<EOF
[Service]
Environment=OLLAMA_HOST=127.0.0.1:11434
Environment=OLLAMA_NUM_PARALLEL=1
Environment=OLLAMA_MAX_LOADED_MODELS=1
Environment=OLLAMA_KEEP_ALIVE=10m
Environment=OLLAMA_CONTEXT_LENGTH=8192
EOF
  systemctl daemon-reload
  systemctl enable ollama >/dev/null 2>&1 || true
  systemctl restart ollama
  for i in {1..30}; do curl -fsS http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS http://127.0.0.1:11434/api/version >/dev/null || die "Ollama ไม่ตอบที่ 127.0.0.1:11434 — ดู: journalctl -u ollama -n 50"
  echo "  ดาวน์โหลดโมเดล ${AI_MODEL} (ครั้งแรกใช้เวลาหลายนาที)"
  OLLAMA_HOST=127.0.0.1:11434 ollama pull "$AI_MODEL" || die "ดาวน์โหลดโมเดล ${AI_MODEL} ไม่สำเร็จ — ตรวจอินเทอร์เน็ต/ดิสก์ แล้วรันซ้ำ"
  ok "Ollama $(ollama --version 2>/dev/null | awk '{print $NF}') + ${AI_MODEL} พร้อม (127.0.0.1:11434)"
else
  ok "ไม่ติดตั้ง Ollama (AI_PROVIDER=${AI_PROVIDER})"
fi

# ---------- 6. ไฟล์ .env ----------
step "6/11 เตรียมไฟล์ .env"
FRESH_ENV=0
if [[ ! -f "$ENV_FILE" ]]; then
  FRESH_ENV=1
  if [[ -f "$SRC_DIR/.env" ]]; then
    cp "$SRC_DIR/.env" "$ENV_FILE"; ok "ใช้ .env จากโฟลเดอร์โปรเจค"
  else
    cp "$APP_DIR/.env.example" "$ENV_FILE"; ok "สร้าง .env ใหม่จาก .env.example"
  fi
  sed -i 's/\r$//' "$ENV_FILE"   # กันไฟล์ที่มาจาก Windows (CRLF)
fi
for k in APP_SECRET ADMIN_PASSWORD AUTOMATION_TOKEN POSTGRES_PASSWORD N8N_ENCRYPTION_KEY; do env_secret "$k"; done
# ใช้แต่โมเดล AI ฟรี: ลบคีย์ Claude (เสียเงิน) ที่อาจค้างจาก .env เดิม
sed -i -e '/^ANTHROPIC_API_KEY=/d' -e '/^ANTHROPIC_MODEL=/d' -e '/^# Claude API/d' "$ENV_FILE"
env_set AI_PROVIDER "$AI_PROVIDER"
env_set AI_MODEL "$AI_MODEL"
[[ "$AI_PROVIDER" == ollama ]] && env_set AI_BASE_URL "http://127.0.0.1:11434"
[[ -n "$AI_API_KEY_IN" ]] && env_set AI_API_KEY "$AI_API_KEY_IN"
if [[ "$AI_PROVIDER" =~ ^(groq|gemini|openrouter)$ && -z "$(env_get AI_API_KEY)" ]]; then
  warn "AI_PROVIDER=${AI_PROVIDER} ต้องมีคีย์ฟรี: ใส่ AI_API_KEY ใน ${ENV_FILE} หรือในหน้า ตั้งค่า → AI"
fi

SERVER_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src"){print $(i+1); exit}}')"
[[ -n "$SERVER_IP" ]] || SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [[ -n "$DOMAIN" ]]; then
  if [[ "$BEHIND_CF" == yes || -n "$LE_EMAIL" ]]; then PUBLIC_URL="https://$DOMAIN"; else PUBLIC_URL="http://$DOMAIN"; fi
else
  PUBLIC_URL="http://$SERVER_IP"
fi
DB_PASS="$(env_get POSTGRES_PASSWORD)"

env_set NODE_ENV production
env_set TIMEZONE "$(env_get TIMEZONE | grep . || echo Asia/Bangkok)"
env_set PORT "$APP_PORT"
env_set PUBLIC_URL "$PUBLIC_URL"
env_set POSTGRES_DB "$DB_NAME"
env_set POSTGRES_USER "$DB_USER"
env_set DATABASE_URL "postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}"
env_set MEDIA_ROOT "/var/lib/$APP_NAME/media"
env_set SUBTITLE_FONT '"Noto Sans Thai"'
env_set SUBTITLE_FONTS_DIR ""
env_set STATIC_DIR "$APP_DIR/frontend/dist"
[[ -z "$(env_get TIMEZONE)" ]] && env_set TIMEZONE "Asia/Bangkok"
[[ -z "$(env_get PUBLISHER_MODE)" ]] && env_set PUBLISHER_MODE mock
[[ -z "$(env_get SEED_DEMO)" ]] && env_set SEED_DEMO false
# ติดตั้งครั้งแรก: .env อาจมาจากเครื่องพัฒนา ห้ามเอาข้อมูลตัวอย่างขึ้นระบบจริง
[[ "$FRESH_ENV" == 1 ]] && env_set SEED_DEMO false
chown "$APP_USER:$APP_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"
ok ".env พร้อม (PUBLIC_URL=$PUBLIC_URL)"

# ---------- 7. PostgreSQL ----------
step "7/11 ตั้งค่า PostgreSQL"
systemctl enable --now postgresql
cd /   # ให้ผู้ใช้ postgres ไม่เตือน "could not change directory"
for i in {1..20}; do runuser -u postgres -- pg_isready -q && break; sleep 1; done
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';
  END IF;
END \$\$;
SQL
runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || runuser -u postgres -- createdb -O "$DB_USER" -E UTF8 -T template0 "$DB_NAME"
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -q -d "$DB_NAME" <<SQL
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS n8n AUTHORIZATION ${DB_USER};
ALTER SCHEMA public OWNER TO ${DB_USER};
GRANT ALL ON SCHEMA public TO ${DB_USER};
SQL
ok "ฐานข้อมูล ${DB_NAME} พร้อม (ตาราง/ migration จะสร้างอัตโนมัติตอนแอปเริ่ม)"

# ---------- 8. build แอป ----------
step "8/11 ติดตั้ง dependencies และ build frontend"
cd "$APP_DIR/frontend"
runuser -u "$APP_USER" -- npm ci --no-audit --no-fund
runuser -u "$APP_USER" -- npm run build
cd "$APP_DIR/backend"
runuser -u "$APP_USER" -- npm ci --omit=dev --no-audit --no-fund
ok "build สำเร็จ"

# ---------- 9. systemd services ----------
step "9/11 สร้าง systemd services"
OLLAMA_UNIT=$([[ "$INSTALL_OLLAMA" == yes ]] && echo " ollama.service" || true)
cat > /etc/systemd/system/${APP_NAME}.service <<EOF
[Unit]
Description=AI Social Automation (API + Dashboard)
After=network-online.target postgresql.service${OLLAMA_UNIT}
Wants=network-online.target${OLLAMA_UNIT}
Requires=postgresql.service

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}/backend
Environment=PATH=${APP_DIR}/.venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${NODE_BIN} --env-file=${ENV_FILE} server.js
Restart=always
RestartSec=5
LimitNOFILE=65535
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=/var/lib/${APP_NAME} /tmp

[Install]
WantedBy=multi-user.target
EOF

if [[ "$INSTALL_N8N" == "yes" ]]; then
  step "   ติดตั้ง n8n (อาจใช้เวลาหลายนาที)"
  install -d -o "$APP_USER" -g "$APP_USER" /var/lib/n8n
  # ติดตั้งใหม่ถ้ายังไม่มี/รันไม่ได้; ถ้า Node เปลี่ยนเวอร์ชัน ต้อง rebuild native module (เช่น isolated-vm)
  N8N_ABI_FILE=/var/lib/n8n/.node-abi
  NODE_ABI="$(node -p process.versions.modules)"
  if ! command -v n8n >/dev/null || ! n8n --version >/dev/null 2>&1; then
    npm install -g n8n --no-audit --no-fund
  elif [[ "$(cat "$N8N_ABI_FILE" 2>/dev/null)" != "$NODE_ABI" ]]; then
    warn "Node เปลี่ยนเวอร์ชัน — rebuild native modules ของ n8n"
    (cd "$(npm root -g)/n8n" && npm rebuild --no-audit --no-fund)
  fi
  n8n --version >/dev/null 2>&1 || die "n8n รันไม่ได้กับ Node $(node -v) — ดู: n8n --version"
  echo "$NODE_ABI" > "$N8N_ABI_FILE"
  npm cache clean --force >/dev/null 2>&1 || true
  if [[ -n "$N8N_DOMAIN" ]]; then
    N8N_PROTO=$([[ -n "$LE_EMAIL" || "$BEHIND_CF" == yes ]] && echo https || echo http)
    N8N_BASE="${N8N_PROTO}://${N8N_DOMAIN}/"; N8N_HOSTNAME="$N8N_DOMAIN"
    N8N_SECURE=$([[ "$N8N_PROTO" == https ]] && echo true || echo false)
  else
    N8N_PROTO=http; N8N_BASE=""; N8N_HOSTNAME=localhost; N8N_SECURE=false
  fi
  cat > /etc/${APP_NAME}-n8n.env <<EOF
DB_TYPE=postgresdb
DB_POSTGRESDB_HOST=127.0.0.1
DB_POSTGRESDB_PORT=5432
DB_POSTGRESDB_DATABASE=${DB_NAME}
DB_POSTGRESDB_USER=${DB_USER}
DB_POSTGRESDB_PASSWORD=${DB_PASS}
DB_POSTGRESDB_SCHEMA=n8n
N8N_HOST=${N8N_HOSTNAME}
N8N_LISTEN_ADDRESS=127.0.0.1
N8N_PORT=${N8N_PORT}
N8N_PROTOCOL=${N8N_PROTO}
N8N_EDITOR_BASE_URL=${N8N_BASE}
WEBHOOK_URL=${N8N_BASE}
N8N_ENCRYPTION_KEY=$(env_get N8N_ENCRYPTION_KEY)
N8N_SECURE_COOKIE=${N8N_SECURE}
GENERIC_TIMEZONE=$(env_get TIMEZONE)
TZ=$(env_get TIMEZONE)
EXECUTIONS_CONCURRENCY_PRODUCTION_LIMIT=1
N8N_DIAGNOSTICS_ENABLED=false
N8N_BLOCK_ENV_ACCESS_IN_NODE=false
AUTOMATION_TOKEN=$(env_get AUTOMATION_TOKEN)
N8N_USER_FOLDER=/var/lib/n8n
EOF
  chmod 600 /etc/${APP_NAME}-n8n.env
  cat > /etc/systemd/system/n8n.service <<EOF
[Unit]
Description=n8n workflow automation
After=network-online.target postgresql.service ${APP_NAME}.service
Requires=postgresql.service

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
EnvironmentFile=/etc/${APP_NAME}-n8n.env
ExecStart=$(command -v n8n) start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
fi

systemctl daemon-reload
systemctl enable ${APP_NAME} >/dev/null
systemctl restart ${APP_NAME}
if [[ "$INSTALL_N8N" == "yes" ]]; then systemctl enable n8n >/dev/null; systemctl restart n8n; fi

echo -n "  รอแอปเริ่มทำงาน"
for i in {1..45}; do
  curl -fsS "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null 2>&1 && { echo; ok "แอปตอบสนองที่ /api/health"; break; }
  echo -n "."; sleep 2
  [[ $i -eq 45 ]] && { echo; journalctl -u ${APP_NAME} -n 40 --no-pager; die "แอปไม่เริ่มทำงาน"; }
done

if [[ "$INSTALL_N8N" == "yes" ]]; then
  echo -n "  รอ n8n เริ่มทำงาน"
  for i in {1..60}; do
    # /healthz ตอบได้ก่อน n8n crash ตอน init — ต้องยังอยู่หลังผ่านไป 15 วินาทีด้วย
    if curl -fsS "http://127.0.0.1:${N8N_PORT}/healthz" >/dev/null 2>&1; then
      sleep 15
      if systemctl is-active -q n8n && [[ "$(systemctl show n8n -p NRestarts --value)" == 0 ]]; then
        echo; ok "n8n ตอบสนองที่ /healthz"; break
      fi
    fi
    echo -n "."; sleep 3
    [[ $i -eq 60 ]] && { echo; journalctl -u n8n -n 30 --no-pager; warn "n8n ยังไม่ตอบสนอง ตรวจ: journalctl -u n8n -f"; }
  done
fi

# ---------- 10. Nginx + HTTPS ----------
step "10/11 ตั้งค่า Nginx"
# ปิด site เดิมของ TurnKey (สำรองไว้ใน /etc/nginx/sites-disabled-turnkey)
install -d /etc/nginx/sites-disabled-turnkey
for f in /etc/nginx/sites-enabled/*; do
  [[ -e "$f" && "$(basename "$f")" != "$APP_NAME" ]] && mv "$f" /etc/nginx/sites-disabled-turnkey/ || true
done

APP_SERVER_NAME="${DOMAIN:-_}"
# หลัง Cloudflare Tunnel ผู้ใช้เข้ามาด้วย https เสมอ
if [[ "$BEHIND_CF" == yes ]]; then FWD_PROTO='https'; APP_SERVER_NAME="${DOMAIN:+$DOMAIN }_"; LISTEN_OPTS=" default_server"; else FWD_PROTO='$scheme'; fi
[[ "$BEHIND_CF" == yes ]] || LISTEN_OPTS=$([[ -z "$DOMAIN" ]] && echo " default_server" || echo "")
cat > /etc/nginx/sites-available/${APP_NAME} <<EOF
# สร้างโดย install.sh
server {
    listen 80${LISTEN_OPTS};
    listen [::]:80${LISTEN_OPTS};
    server_name ${APP_SERVER_NAME};

    client_max_body_size 600m;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto ${FWD_PROTO};
        proxy_read_timeout 900s;
        proxy_send_timeout 900s;
    }
}
EOF
if [[ "$INSTALL_N8N" == "yes" && -n "$N8N_DOMAIN" ]]; then
cat >> /etc/nginx/sites-available/${APP_NAME} <<EOF

server {
    listen 80;
    listen [::]:80;
    server_name ${N8N_DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${N8N_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto ${FWD_PROTO};
        proxy_buffering off;
        proxy_read_timeout 900s;
    }
}
EOF
fi
ln -sf /etc/nginx/sites-available/${APP_NAME} /etc/nginx/sites-enabled/${APP_NAME}
nginx -t
systemctl enable nginx >/dev/null
systemctl reload nginx || systemctl restart nginx
ok "Nginx พร้อม"

if [[ "$CF_TUNNEL" == existing ]]; then
  step "   Cloudflare Tunnel (ใช้ tunnel เดิมที่ตั้งไว้แล้ว)"
  ok "ไม่ติดตั้ง cloudflared บนเครื่องนี้ — ใน Cloudflare ให้ route ${DOMAIN} → http://${SERVER_IP} (พอร์ต 80)"
  # nginx reload ทำงานแบบ async — ลองซ้ำสักครู่ก่อนสรุปว่าไม่ผ่าน
  nginx_ok=no
  for i in {1..10}; do
    curl -fsS -m 5 -H "Host: ${DOMAIN}" "http://127.0.0.1/api/health" >/dev/null 2>&1 && { nginx_ok=yes; break; }
    sleep 1
  done
  if [[ "$nginx_ok" == yes ]]; then
    ok "Nginx ตอบ Host ${DOMAIN} ได้ถูกต้อง"
  else
    warn "ทดสอบ Nginx ด้วย Host ${DOMAIN} ไม่ผ่าน ตรวจ: nginx -t และ journalctl -u nginx"
  fi
elif [[ "$CF_TUNNEL" == yes ]]; then
  step "   Cloudflare Tunnel"
  if ! command -v cloudflared >/dev/null; then
    curl -fsSL https://pkg.cloudflare.com/cloudflare-public-v2.gpg -o /usr/share/keyrings/cloudflare-public-v2.gpg
    # "any" ใช้ได้ทั้ง Debian 12 และ 13
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-public-v2.gpg] https://pkg.cloudflare.com/cloudflared any main" \
      > /etc/apt/sources.list.d/cloudflared.list
    apt-get update -y && apt-get install -y cloudflared
  fi
  CF_DIR=/etc/cloudflared
  if [[ -n "$CF_TUNNEL_TOKEN" ]]; then
    # วิธีเดิม: tunnel ที่สร้างใน Cloudflare Dashboard (ใช้ token)
    systemctl is-enabled cloudflared >/dev/null 2>&1 || cloudflared service install "$CF_TUNNEL_TOKEN"
    systemctl restart cloudflared
    ok "cloudflared ทำงานแล้ว (ใช้ token)"
  else
    # วิธีไม่ต้องใช้ token: ล็อกอิน Cloudflare ผ่านเบราว์เซอร์ครั้งเดียว แล้วสคริปต์สร้าง tunnel + DNS ให้เอง
    CF_TUNNEL_NAME="${CF_TUNNEL_NAME:-$APP_NAME}"
    export TUNNEL_ORIGIN_CERT="${TUNNEL_ORIGIN_CERT:-/root/.cloudflared/cert.pem}"
    install -d -m 700 /root/.cloudflared "$CF_DIR"
    if [[ ! -s "$TUNNEL_ORIGIN_CERT" ]]; then
      if [[ -t 0 ]]; then
        echo
        echo "  ┌────────────────────────────────────────────────────────────┐"
        echo "  │ เปิดลิงก์ที่จะแสดงด้านล่างในเบราว์เซอร์ → ล็อกอิน Cloudflare │"
        echo "  │ → เลือกโดเมน itdev.in.th → กด Authorize (สคริปต์รอให้เอง)   │"
        echo "  └────────────────────────────────────────────────────────────┘"
        cloudflared tunnel login || warn "ล็อกอิน Cloudflare ไม่สำเร็จ"
      else
        warn "รันแบบไม่มีเทอร์มินัล จึงล็อกอิน Cloudflare ไม่ได้ — รันสคริปต์ใหม่จากเทอร์มินัลจริง (SSH) หรือใส่ CF_TUNNEL_TOKEN"
      fi
    fi
    if [[ -s "$TUNNEL_ORIGIN_CERT" ]]; then
      if ! cloudflared tunnel list --output json 2>/dev/null | grep -q "\"name\": *\"${CF_TUNNEL_NAME}\""; then
        cloudflared tunnel create "$CF_TUNNEL_NAME"
      fi
      CF_UUID="$(cloudflared tunnel list --output json | python3 -c 'import sys,json
n=sys.argv[1]
for t in json.load(sys.stdin):
    if t["name"]==n and not t.get("deleted_at"): print(t["id"]); break' "$CF_TUNNEL_NAME")"
      [[ -n "$CF_UUID" ]] || die "ไม่พบ tunnel ${CF_TUNNEL_NAME} หลังสร้าง"
      [[ -s "/root/.cloudflared/${CF_UUID}.json" ]] && install -m 600 "/root/.cloudflared/${CF_UUID}.json" "$CF_DIR/${CF_UUID}.json"
      [[ -s "$CF_DIR/${CF_UUID}.json" ]] || die "ไม่พบไฟล์ credentials ของ tunnel (/root/.cloudflared/${CF_UUID}.json) — ลบ tunnel ใน Cloudflare แล้วรันใหม่"
      cloudflared tunnel route dns --overwrite-dns "$CF_UUID" "$DOMAIN" || warn "ตั้ง DNS ของ $DOMAIN ไม่สำเร็จ (โดเมนต้องอยู่ใน Cloudflare)"
      {
        echo "tunnel: ${CF_UUID}"
        echo "credentials-file: ${CF_DIR}/${CF_UUID}.json"
        echo "ingress:"
        echo "  - hostname: ${DOMAIN}"
        echo "    service: http://localhost:80"
        if [[ "$INSTALL_N8N" == "yes" && -n "$N8N_DOMAIN" ]]; then
          cloudflared tunnel route dns --overwrite-dns "$CF_UUID" "$N8N_DOMAIN" || warn "ตั้ง DNS ของ $N8N_DOMAIN ไม่สำเร็จ"
          echo "  - hostname: ${N8N_DOMAIN}"
          echo "    service: http://localhost:80"
        fi
        echo "  - service: http_status:404"
      } > "$CF_DIR/config.yml"
      chmod 600 "$CF_DIR/config.yml"
      cloudflared --config "$CF_DIR/config.yml" tunnel ingress validate
      systemctl is-enabled cloudflared >/dev/null 2>&1 || cloudflared --config "$CF_DIR/config.yml" service install
      systemctl enable cloudflared >/dev/null 2>&1 || true
      systemctl restart cloudflared
      ok "cloudflared ทำงานแล้ว: https://${DOMAIN} → localhost:80 (tunnel ${CF_TUNNEL_NAME})"
    else
      warn "ยังไม่ได้ตั้ง Cloudflare Tunnel — แอปรันที่ http://127.0.0.1:${APP_PORT} (ภายในเครื่องเท่านั้น) รันสคริปต์ซ้ำเพื่อล็อกอิน Cloudflare"
    fi
  fi
elif [[ -n "$DOMAIN" && -n "$LE_EMAIL" ]]; then
  step "   ขอใบรับรอง HTTPS (Let's Encrypt)"
  CERT_DOMAINS=(-d "$DOMAIN")
  [[ "$INSTALL_N8N" == "yes" && -n "$N8N_DOMAIN" ]] && CERT_DOMAINS+=(-d "$N8N_DOMAIN")
  if certbot --nginx --non-interactive --agree-tos --redirect -m "$LE_EMAIL" "${CERT_DOMAINS[@]}"; then
    ok "เปิด HTTPS แล้ว (ต่ออายุอัตโนมัติด้วย certbot.timer)"
  else
    warn "ขอ HTTPS ไม่สำเร็จ — ตรวจว่า DNS ชี้มาที่ ${SERVER_IP} แล้วรัน: certbot --nginx ${CERT_DOMAINS[*]}"
  fi
fi

# ---------- 11. ความปลอดภัย + การดูแลระบบ (swap, firewall, สำรองข้อมูล, เฝ้าระวัง) ----------
step "11/11 swap, firewall, สำรองข้อมูล, ตรวจสุขภาพระบบ"

# 11.1 swap (FFmpeg + PostgreSQL + n8n + โมเดล AI พร้อมกันเสี่ยง OOM บนเครื่อง RAM น้อย)
SWAP_LIMIT_KB=$([[ "$INSTALL_OLLAMA" == yes ]] && echo 8388608 || echo 3145728)
if [[ -z "$(swapon --show --noheadings 2>/dev/null)" && "$mem_kb" -le "$SWAP_LIMIT_KB" ]]; then
  if { fallocate -l "${SWAP_MB}M" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_MB" status=none; } \
     && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo 'vm.swappiness=10' > /etc/sysctl.d/99-ai-social.conf; sysctl -q -p /etc/sysctl.d/99-ai-social.conf || true
    ok "สร้าง swap ${SWAP_MB} MB"
  else
    rm -f /swapfile; warn "สร้าง swap ไม่ได้ (อาจเป็น container/LXC) — ข้าม"
  fi
else
  ok "swap: $(swapon --show --noheadings 2>/dev/null | awk '{print $3}' | paste -sd, - || true) (ไม่ต้องสร้างเพิ่ม)"
fi

# 11.2 จำกัดขนาด log
install -d /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=300M\nMaxRetentionSec=1month\n' > /etc/systemd/journald.conf.d/ai-social.conf
systemctl restart systemd-journald 2>/dev/null || true
cat > /etc/logrotate.d/${APP_NAME} <<EOF
${LOG_FILE} {
    monthly
    rotate 6
    compress
    missingok
    notifempty
}
EOF
ok "จำกัด journal 300 MB และหมุน log ติดตั้ง"

# 11.3 firewall + fail2ban
if [[ "$ENABLE_UFW" == yes ]]; then
  SSH_PORT="$(ss -tlnp 2>/dev/null | awk '/sshd/ {n=split($4,a,":"); print a[n]; exit}')"
  if [[ -z "$SSH_PORT" ]]; then
    warn "หาพอร์ต SSH ไม่เจอ — ข้าม firewall เพื่อกันล็อกตัวเองออก (ตั้งเองด้วย ufw ภายหลัง)"
  else
    apt-get install -y --no-install-recommends ufw fail2ban python3-systemd >/dev/null
    ufw --force reset >/dev/null
    ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
    ufw allow "${SSH_PORT}/tcp" >/dev/null
    # หลัง Cloudflare Tunnel ไม่ต้องเปิด 80/443 ออกอินเทอร์เน็ต (cloudflared ต่อออกไปเอง)
    if [[ "$CF_TUNNEL" == existing ]]; then
      # tunnel อยู่ที่เครื่องอื่นในวง LAN: เปิดพอร์ต 80 ให้เฉพาะเครือข่ายภายใน
      for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do ufw allow from "$net" to any port 80 proto tcp >/dev/null; done
    elif [[ "$CF_TUNNEL" != yes ]]; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
    # TurnKey: คงพอร์ตหน้าจัดการที่เปิดอยู่ไว้ ไม่งั้นอาจเข้าเครื่องไม่ได้
    for p in 12320 12321 12322 12323; do
      ss -tln 2>/dev/null | grep -q ":${p} " && { ufw allow "${p}/tcp" >/dev/null; warn "เปิดพอร์ต TurnKey ${p} ไว้ (ปิดเองได้ด้วย: ufw delete allow ${p}/tcp)"; }
    done
    ufw --force enable >/dev/null
    printf '[sshd]\nenabled = true\nbackend = systemd\nmaxretry = 5\nbantime = 1h\n' > /etc/fail2ban/jail.d/ai-social.local
    systemctl enable --now fail2ban >/dev/null 2>&1 || true
    systemctl restart fail2ban 2>/dev/null || true
    ok "ufw เปิดแล้ว (SSH ${SSH_PORT}$(case "$CF_TUNNEL" in existing) echo ', พอร์ต 80 เฉพาะวง LAN';; yes) echo ', ไม่เปิด 80/443 ออกนอก';; *) echo ', 80, 443';; esac)) + fail2ban"
  fi
fi

# 11.4 แจ้งเตือน (webhook แบบ Discord/Slack) — ไม่ใส่ URL ก็ไม่ส่ง
umask 077
[[ -f /etc/${APP_NAME}-alert.env ]] || echo "ALERT_WEBHOOK_URL=" > /etc/${APP_NAME}-alert.env
[[ -n "$ALERT_WEBHOOK_URL" ]] && sed -i "s|^ALERT_WEBHOOK_URL=.*|ALERT_WEBHOOK_URL=${ALERT_WEBHOOK_URL//|/\\|}|" /etc/${APP_NAME}-alert.env
umask 022
cat > /usr/local/sbin/${APP_NAME}-alert <<'EOF'
#!/usr/bin/env bash
# ใช้: ai-social-alert "ข้อความ"   (อ่าน ALERT_WEBHOOK_URL จาก /etc/ai-social-alert.env)
set -u
msg="[$(hostname)] $*"
logger -t ai-social-alert "$msg"
. /etc/ai-social-alert.env 2>/dev/null || exit 0
[[ -n "${ALERT_WEBHOOK_URL:-}" ]] || exit 0
json=$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g')
curl -fsS -m 10 -H 'Content-Type: application/json' -d "{\"content\":\"$json\",\"text\":\"$json\"}" "$ALERT_WEBHOOK_URL" >/dev/null || true
EOF
chmod 755 /usr/local/sbin/${APP_NAME}-alert

# 11.5 สำรองข้อมูลทุกวัน (ฐานข้อมูล + .env) เก็บ 14 วัน
cat > /usr/local/sbin/${APP_NAME}-backup <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
DEST=/var/backups/${APP_NAME}; KEEP_DAYS=14; BACKUP_MEDIA="${BACKUP_MEDIA}"
trap '/usr/local/sbin/${APP_NAME}-alert "สำรองข้อมูลล้มเหลว (ดู journalctl -u ${APP_NAME}-backup)"' ERR
install -d -m 700 "\$DEST"; ts=\$(date +%F_%H%M)
runuser -u postgres -- pg_dump --format=custom ${DB_NAME} > "\$DEST/db-\$ts.dump"
tar -czf "\$DEST/config-\$ts.tgz" -C / ${APP_DIR#/}/.env etc/${APP_NAME}-n8n.env 2>/dev/null || true
if [[ "\$BACKUP_MEDIA" == yes ]]; then tar -czf "\$DEST/media-\$ts.tgz" -C / var/lib/${APP_NAME}/media; fi
chmod 600 "\$DEST"/*-"\$ts".*
find "\$DEST" -type f -mtime +\$KEEP_DAYS -delete
echo "backup ok: \$DEST (\$(du -sh "\$DEST" | cut -f1))"
EOF
chmod 755 /usr/local/sbin/${APP_NAME}-backup
cat > /etc/systemd/system/${APP_NAME}-backup.service <<EOF
[Unit]
Description=AI Social Automation daily backup
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/${APP_NAME}-backup
EOF
cat > /etc/systemd/system/${APP_NAME}-backup.timer <<EOF
[Unit]
Description=Daily backup at 03:30
[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=300
Persistent=true
[Install]
WantedBy=timers.target
EOF

# 11.6 ตรวจสุขภาพทุก 5 นาที: ล่ม 2 ครั้งติด -> รีสตาร์ท + แจ้งเตือน, ดิสก์เกิน 85% -> แจ้งเตือน
cat > /usr/local/sbin/${APP_NAME}-healthcheck <<EOF
#!/usr/bin/env bash
set -u
STATE=/run/${APP_NAME}-health.fails
if curl -fsS -m 10 "http://127.0.0.1:${APP_PORT}/api/ready" >/dev/null 2>&1; then
  [[ -f "\$STATE" ]] && /usr/local/sbin/${APP_NAME}-alert "แอปกลับมาทำงานปกติแล้ว"
  rm -f "\$STATE"
else
  n=\$(( \$(cat "\$STATE" 2>/dev/null || echo 0) + 1 )); echo "\$n" > "\$STATE"
  if [[ \$n -eq 2 ]]; then
    /usr/local/sbin/${APP_NAME}-alert "แอปไม่ตอบ /api/ready 2 ครั้งติด — กำลังรีสตาร์ท"
    systemctl restart ${APP_NAME}
  fi
fi
use=\$(df --output=pcent /var/lib/${APP_NAME} | tail -1 | tr -dc 0-9)
if [[ "\${use:-0}" -ge 85 ]]; then
  [[ -f /run/${APP_NAME}-disk.warned ]] || { /usr/local/sbin/${APP_NAME}-alert "ดิสก์ใช้ไป \${use}% — ลบวิดีโอเก่าหรือขยายดิสก์"; touch /run/${APP_NAME}-disk.warned; }
else rm -f /run/${APP_NAME}-disk.warned; fi
EOF
chmod 755 /usr/local/sbin/${APP_NAME}-healthcheck
cat > /etc/systemd/system/${APP_NAME}-healthcheck.service <<EOF
[Unit]
Description=AI Social Automation health check
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/${APP_NAME}-healthcheck
EOF
cat > /etc/systemd/system/${APP_NAME}-healthcheck.timer <<EOF
[Unit]
Description=Health check every 5 minutes
[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now ${APP_NAME}-backup.timer ${APP_NAME}-healthcheck.timer >/dev/null
/usr/local/sbin/${APP_NAME}-backup >/dev/null && ok "สำรองข้อมูลทดสอบ 1 ครั้งสำเร็จ → /var/backups/${APP_NAME}" || warn "สำรองข้อมูลทดสอบไม่ผ่าน ดู journalctl"
ok "ตั้งเวลาสำรอง 03:30 ทุกวัน + ตรวจสุขภาพทุก 5 นาที (ใส่ ALERT_WEBHOOK_URL ใน /etc/${APP_NAME}-alert.env เพื่อรับแจ้งเตือน)"

# ---------- สรุป ----------
cat <<EOF

============================================================
 ติดตั้งเสร็จสมบูรณ์
============================================================
 Dashboard     : ${PUBLIC_URL}
 Admin email   : $(env_get ADMIN_EMAIL)
 Admin password: $(env_get ADMIN_PASSWORD)
 n8n           : $( [[ "$INSTALL_N8N" != yes ]] && echo "ไม่ได้ติดตั้ง" || { [[ -n "$N8N_DOMAIN" ]] && echo "${N8N_BASE}" || echo "127.0.0.1:${N8N_PORT} (ssh -L ${N8N_PORT}:127.0.0.1:${N8N_PORT} root@${SERVER_IP})"; } )

 AI (ฟรี)       : ${AI_PROVIDER} ${AI_MODEL}$([[ "$INSTALL_OLLAMA" == yes ]] && echo "  (Ollama บนเครื่องนี้ ไม่มีค่า API)")
 ไฟล์ตั้งค่า    : ${ENV_FILE}   (ใส่ OAuth keys ที่นี่ / เปลี่ยนโมเดล: แก้ AI_MODEL แล้ว ollama pull <model>)
 วิดีโอ/สื่อ     : /var/lib/${APP_NAME}/media
 Log ติดตั้ง    : ${LOG_FILE}

 คำสั่งที่ใช้บ่อย:
   systemctl status ${APP_NAME}         # ดูสถานะแอป
   journalctl -u ${APP_NAME} -f         # ดู log แอปแบบสด
   systemctl restart ${APP_NAME}        # รีสตาร์ทหลังแก้ .env
   journalctl -u n8n -f                 # ดู log n8n
   journalctl -u ollama -f              # ดู log โมเดล AI
   ollama list                          # โมเดลที่ดาวน์โหลดไว้
   bash install.sh                      # รันซ้ำเพื่ออัปเดตโค้ด

 สำรองข้อมูล   : /var/backups/${APP_NAME}  (ทุกวัน 03:30, เก็บ 14 วัน)  สั่งเองด้วย: ${APP_NAME}-backup
   กู้คืน: systemctl stop ${APP_NAME} && runuser -u postgres -- pg_restore --clean --if-exists -d ${DB_NAME} <ไฟล์ db-*.dump> && systemctl start ${APP_NAME}
 แจ้งเตือน     : ใส่ ALERT_WEBHOOK_URL ใน /etc/${APP_NAME}-alert.env

 หมายเหตุ: PUBLISHER_MODE=$(env_get PUBLISHER_MODE) — เปลี่ยนเป็น live เมื่อพร้อมโพสต์จริง
EOF
