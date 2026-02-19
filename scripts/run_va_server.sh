#!/usr/bin/env bash
# Run the V/A (valence/arousal) model server from the bundle. Run from repo root.
cd "$(dirname "$0")/../vcm_website_bundle"
if [ ! -f "checkpoints/va_late_fusion_speech_emotion.joblib" ]; then
  echo "ERROR: Model not found. Copy va_late_fusion_speech_emotion.joblib into vcm_website_bundle/checkpoints/"
  exit 1
fi
echo "Starting V/A server on http://localhost:5000"
exec python server.py
