#!/usr/bin/env bash
# =============================================================================
#  AI Social Automation — ตัวติดตั้งแบบไม่ใช้ Docker
#  สำหรับ: TurnKey Linux Node.js (debian-12-turnkey-nodejs_18.0-1) / Debian 12
#
#  ติดตั้งให้ครบ: Node.js 22, PostgreSQL, FFmpeg + ฟอนต์ไทย, edge-tts,
#  n8n, Nginx (reverse proxy), systemd services, HTTPS (ถ้าใส่โดเมน)
#
#  วิธีใช้ (ในโฟลเดอร์โปรเจคบนเซิร์ฟเวอร์, รันด้วย root):
#     bash install.sh
#  หรือกำหนดค่าล่วงหน้า:
#     DOMAIN=app.example.com N8N_DOMAIN=n8n.example.com LE_EMAIL=me@example.com bash install.sh
#
#  ตัวแปรที่ปรับได้ (ไม่ใส่ก็ได้):
#     DOMAIN        โดเมนของหน้า dashboard (ไม่ใส่ = ใช้ IP ของเครื่อง, http)
#     N8N_DOMAIN    โดเมนของ n8n (ไม่ใส่ = n8n ฟังเฉพาะ 127.0.0.1:5678)
#     LE_EMAIL      อีเมลสำหรับ Let's Encrypt (ต้องมีพร้อม DOMAIN จึงจะขอ HTTPS)
#     INSTALL_N8N   yes/no  (ค่าเริ่มต้น yes)
#     APP_DIR       ที่ติดตั้ง (ค่าเริ่มต้น /opt/ai-social)
#     APP_PORT      พอร์ตภายในของแอป (ค่าเริ่มต้น 3000)
#     CF_TUNNEL     yes = อยู่หลัง Cloudflare Tunnel (HTTPS จัดการโดย Cloudflare, ไม่ใช้ certbot)
#     CF_TUNNEL_TOKEN  token ของ tunnel (ถ้าใส่ จะติดตั้ง cloudflared เป็น service ให้)
#
#  ตัวอย่าง Cloudflare Tunnel:
#     CF_TUNNEL=yes DOMAIN=automation.itdev.in.th CF_TUNNEL_TOKEN=eyJ... bash install.sh
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
DOMAIN="${DOMAIN:-}"
N8N_DOMAIN="${N8N_DOMAIN:-}"
LE_EMAIL="${LE_EMAIL:-}"
INSTALL_N8N="${INSTALL_N8N:-yes}"
CF_TUNNEL_TOKEN="${CF_TUNNEL_TOKEN:-}"
CF_TUNNEL="${CF_TUNNEL:-$([[ -n "$CF_TUNNEL_TOKEN" ]] && echo yes || echo no)}"
NODE_MAJOR=22
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
[[ $EUID -eq 0 ]] || die "กรุณารันด้วย root (sudo bash install.sh)"
[[ -f "$SRC_DIR/backend/server.js" && -f "$SRC_DIR/database/schema.sql" ]] \
  || die "ให้วาง install.sh ไว้ที่โฟลเดอร์รากของโปรเจค (ที่มี backend/ frontend/ database/)"
. /etc/os-release
[[ "${VERSION_CODENAME:-}" == "bookworm" ]] || warn "ออกแบบสำหรับ Debian 12 (bookworm) แต่พบ ${PRETTY_NAME:-unknown}"
exec > >(tee -a "$LOG_FILE") 2>&1
export DEBIAN_FRONTEND=noninteractive

echo "============================================================"
echo " AI Social Automation — native install (no Docker)"
echo " Source : $SRC_DIR"
echo " Target : $APP_DIR"
echo " Domain : ${DOMAIN:-<ใช้ IP>}   n8n: ${N8N_DOMAIN:-<localhost only>}"
echo "============================================================"

# ---------- 1. แพ็กเกจระบบ ----------
step "1/9 ติดตั้งแพ็กเกจระบบ"
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg openssl rsync git build-essential \
  nginx postgresql postgresql-contrib \
  ffmpeg fonts-noto-core fonts-thai-tlwg fontconfig \
  python3 python3-venv python3-pip \
  certbot python3-certbot-nginx
fc-cache -f >/dev/null || true
ok "แพ็กเกจระบบพร้อม"

# ---------- 2. Node.js 22 (TurnKey มาพร้อม 18 แต่ backend ต้องการ >=22.9) ----------
step "2/9 ติดตั้ง Node.js ${NODE_MAJOR}"
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
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=9)?0:1)' \
  || die "ต้องการ Node >= 22.9 แต่ได้ $(node -v)"
ok "Node $(node -v), npm $(npm -v)"

# ---------- 3. ผู้ใช้ระบบ + คัดลอกโค้ด ----------
step "3/9 สร้างผู้ใช้ '$APP_USER' และคัดลอกโค้ดไป $APP_DIR"
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
step "4/9 ติดตั้ง edge-tts (เสียงพากย์ไทยฟรี)"
if [[ ! -x "$APP_DIR/.venv/bin/edge-tts" ]]; then
  sudo -u "$APP_USER" python3 -m venv "$APP_DIR/.venv"
fi
sudo -u "$APP_USER" "$APP_DIR/.venv/bin/pip" install --quiet --upgrade pip edge-tts
ln -sf "$APP_DIR/.venv/bin/edge-tts" /usr/local/bin/edge-tts
ok "edge-tts $("$APP_DIR/.venv/bin/edge-tts" --version 2>/dev/null | head -1 || echo installed)"

# ---------- 5. ไฟล์ .env ----------
step "5/9 เตรียมไฟล์ .env"
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$SRC_DIR/.env" ]]; then
    cp "$SRC_DIR/.env" "$ENV_FILE"; ok "ใช้ .env จากโฟลเดอร์โปรเจค"
  else
    cp "$APP_DIR/.env.example" "$ENV_FILE"; ok "สร้าง .env ใหม่จาก .env.example"
  fi
  sed -i 's/\r$//' "$ENV_FILE"   # กันไฟล์ที่มาจาก Windows (CRLF)
fi
for k in APP_SECRET ADMIN_PASSWORD AUTOMATION_TOKEN POSTGRES_PASSWORD N8N_ENCRYPTION_KEY; do env_secret "$k"; done

SERVER_IP="$(hostname -I | awk '{print $1}')"
if [[ -n "$DOMAIN" ]]; then
  if [[ "$CF_TUNNEL" == yes || -n "$LE_EMAIL" ]]; then PUBLIC_URL="https://$DOMAIN"; else PUBLIC_URL="http://$DOMAIN"; fi
else
  PUBLIC_URL="http://$SERVER_IP"
fi
DB_PASS="$(env_get POSTGRES_PASSWORD)"

env_set NODE_ENV production
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
chown "$APP_USER:$APP_USER" "$ENV_FILE"; chmod 600 "$ENV_FILE"
ok ".env พร้อม (PUBLIC_URL=$PUBLIC_URL)"

# ---------- 6. PostgreSQL ----------
step "6/9 ตั้งค่า PostgreSQL"
systemctl enable --now postgresql
for i in {1..20}; do sudo -u postgres pg_isready -q && break; sleep 1; done
sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';
  END IF;
END \$\$;
SQL
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || sudo -u postgres createdb -O "$DB_USER" -E UTF8 -T template0 "$DB_NAME"
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$DB_NAME" <<SQL
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS n8n AUTHORIZATION ${DB_USER};
ALTER SCHEMA public OWNER TO ${DB_USER};
GRANT ALL ON SCHEMA public TO ${DB_USER};
SQL
ok "ฐานข้อมูล ${DB_NAME} พร้อม (ตาราง/ migration จะสร้างอัตโนมัติตอนแอปเริ่ม)"

# ---------- 7. build แอป ----------
step "7/9 ติดตั้ง dependencies และ build frontend"
cd "$APP_DIR/frontend"
sudo -u "$APP_USER" -H npm ci --no-audit --no-fund
sudo -u "$APP_USER" -H npm run build
cd "$APP_DIR/backend"
sudo -u "$APP_USER" -H npm ci --omit=dev --no-audit --no-fund
ok "build สำเร็จ"

# ---------- 8. systemd services ----------
step "8/9 สร้าง systemd services"
cat > /etc/systemd/system/${APP_NAME}.service <<EOF
[Unit]
Description=AI Social Automation (API + Dashboard)
After=network-online.target postgresql.service
Wants=network-online.target
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
  if ! command -v n8n >/dev/null; then npm install -g n8n --no-audit --no-fund; fi
  install -d -o "$APP_USER" -g "$APP_USER" /var/lib/n8n
  if [[ -n "$N8N_DOMAIN" ]]; then
    N8N_PROTO=$([[ -n "$LE_EMAIL" || "$CF_TUNNEL" == yes ]] && echo https || echo http)
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

# ---------- 9. Nginx + HTTPS ----------
step "9/9 ตั้งค่า Nginx"
# ปิด site เดิมของ TurnKey (สำรองไว้ใน /etc/nginx/sites-disabled-turnkey)
install -d /etc/nginx/sites-disabled-turnkey
for f in /etc/nginx/sites-enabled/*; do
  [[ -e "$f" && "$(basename "$f")" != "$APP_NAME" ]] && mv "$f" /etc/nginx/sites-disabled-turnkey/ || true
done

APP_SERVER_NAME="${DOMAIN:-_}"
# หลัง Cloudflare Tunnel ผู้ใช้เข้ามาด้วย https เสมอ
if [[ "$CF_TUNNEL" == yes ]]; then FWD_PROTO='https'; APP_SERVER_NAME="${DOMAIN:+$DOMAIN }_"; LISTEN_OPTS=" default_server"; else FWD_PROTO='$scheme'; fi
[[ "$CF_TUNNEL" == yes ]] || LISTEN_OPTS=$([[ -z "$DOMAIN" ]] && echo " default_server" || echo "")
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
        proxy_set_header X-Forwarded-Proto \${FWD_PROTO};
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
        proxy_set_header X-Forwarded-Proto \${FWD_PROTO};
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

if [[ "$CF_TUNNEL" == yes ]]; then
  step "   Cloudflare Tunnel"
  if [[ -n "$CF_TUNNEL_TOKEN" ]]; then
    if ! command -v cloudflared >/dev/null; then
      curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
      echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared bookworm main" \
        > /etc/apt/sources.list.d/cloudflared.list
      apt-get update -y && apt-get install -y cloudflared
    fi
    systemctl is-enabled cloudflared >/dev/null 2>&1 || cloudflared service install "$CF_TUNNEL_TOKEN"
    systemctl restart cloudflared
    ok "cloudflared ทำงานแล้ว"
  else
    warn "ไม่ได้ใส่ CF_TUNNEL_TOKEN — ถือว่าติดตั้ง cloudflared ไว้แล้ว"
  fi
  ok "ใน Cloudflare ให้ตั้ง Service ของ ${DOMAIN:-hostname} เป็น  HTTP → localhost:80"
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

# ---------- สรุป ----------
cat <<EOF

============================================================
 ติดตั้งเสร็จสมบูรณ์
============================================================
 Dashboard     : ${PUBLIC_URL}
 Admin email   : $(env_get ADMIN_EMAIL)
 Admin password: $(env_get ADMIN_PASSWORD)
 n8n           : $( [[ "$INSTALL_N8N" != yes ]] && echo "ไม่ได้ติดตั้ง" || { [[ -n "$N8N_DOMAIN" ]] && echo "${N8N_BASE}" || echo "127.0.0.1:${N8N_PORT} (ssh -L ${N8N_PORT}:127.0.0.1:${N8N_PORT} root@${SERVER_IP})"; } )

 ไฟล์ตั้งค่า    : ${ENV_FILE}   (ใส่ ANTHROPIC_API_KEY / OAuth keys ที่นี่)
 วิดีโอ/สื่อ     : /var/lib/${APP_NAME}/media
 Log ติดตั้ง    : ${LOG_FILE}

 คำสั่งที่ใช้บ่อย:
   systemctl status ${APP_NAME}         # ดูสถานะแอป
   journalctl -u ${APP_NAME} -f         # ดู log แอปแบบสด
   systemctl restart ${APP_NAME}        # รีสตาร์ทหลังแก้ .env
   journalctl -u n8n -f                 # ดู log n8n
   bash install.sh                      # รันซ้ำเพื่ออัปเดตโค้ด

 หมายเหตุ: PUBLISHER_MODE=$(env_get PUBLISHER_MODE) — เปลี่ยนเป็น live เมื่อพร้อมโพสต์จริง
EOF
