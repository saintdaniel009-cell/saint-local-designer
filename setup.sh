#!/bin/bash
# One-time setup. Run: bash setup.sh
set -e
cd "$(dirname "$0")"
command -v ollama >/dev/null || { echo "Install Ollama first: https://ollama.com/download"; exit 1; }
python3 -m venv .venv
./.venv/bin/pip install -q --upgrade pip "websockets>=13"
chmod +x design
./.venv/bin/python designer.py check
echo
echo "Last step (once): in Figma desktop → Plugins → Development → Import plugin from manifest…"
echo "  → choose $(pwd)/figma-plugin/manifest.json"
echo "Then try:  ./design \"Welcome, phone number and OTP screens\""
