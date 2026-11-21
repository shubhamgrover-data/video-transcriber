#!/usr/bin/env bash
set -euo pipefail

if [ ! -f ".env" ] && [ -f ".env.example" ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

if [ ! -d ".venv" ]; then
  echo "Creating Python virtual environment..."
  python3 -m venv .venv
fi

source .venv/bin/activate
echo "Installing dependencies..."
pip install --upgrade pip >/dev/null
pip install -r requirements.txt

echo ""
echo "Starting ClipScribe on http://localhost:8000 ..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
