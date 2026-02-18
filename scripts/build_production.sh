#!/usr/bin/env bash
# Build frontend for production. Run from repo root.
set -e
cd "$(dirname "$0")/../frontend"
echo "Installing frontend dependencies..."
npm ci 2>/dev/null || npm install
if [ -f .env.production ]; then
  echo "Using frontend/.env.production for VITE_API_BASE"
else
  echo "No frontend/.env.production — API will use same origin. Create from frontend/.env.example if backend is on another URL."
fi
echo "Building..."
npm run build
echo "Done. Output: frontend/dist/"
