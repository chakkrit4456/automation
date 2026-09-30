#!/usr/bin/env bash
set -euo pipefail

echo "AI Social Automation - Debian bootstrap"
echo "Review this script before production use."

sudo apt-get update
sudo apt-get install -y ca-certificates curl git nginx ffmpeg postgresql-client

# Docker installation should follow the current official Docker documentation
# for the installed Debian release.

echo
echo "Next:"
echo "1. Install Docker Engine + Docker Compose plugin."
echo "2. Copy .env.example to .env."
echo "3. Generate strong PostgreSQL/app/n8n secrets."
echo "4. Run: docker compose up -d postgres"
echo "5. Apply: database/schema.sql"
echo "6. Run: docker compose up -d app n8n"
echo "7. Configure Nginx + HTTPS."
echo "8. Configure OAuth apps and external AI/TTS providers."
