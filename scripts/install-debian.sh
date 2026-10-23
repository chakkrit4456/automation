#!/usr/bin/env bash
set -euo pipefail

# The supported installer is ../install.sh (native, no Docker, Debian 13 / 12).
# This file remains for older docs that point here.
echo "AI Social Automation - Debian installer"
echo "Run as root from the project root instead:"
echo "  bash install.sh"
echo
echo "It installs Node.js 24, PostgreSQL, FFmpeg, edge-tts, Ollama with a free AI model,"
echo "n8n, Nginx and systemd services. See docs/14-ขึ้นใช้งานจริง.md."
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/install.sh" "$@"
