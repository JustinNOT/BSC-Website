#!/usr/bin/env bash
# Run backend for production (or local testing). Run from repo root. Loads backend/.env if present.
set -e
cd "$(dirname "$0")/../backend"
if [ -f .env ]; then
  set -a
  source .env
  set +a
  echo "Loaded backend/.env"
fi
if [ -z "$YOUTUBE_API_KEY" ]; then
  echo "ERROR: YOUTUBE_API_KEY is not set. Create backend/.env from backend/.env.example and set YOUTUBE_API_KEY."
  exit 1
fi
echo "Starting backend on http://0.0.0.0:8000"
exec python -m uvicorn main:app --host 0.0.0.0 --port 8000
