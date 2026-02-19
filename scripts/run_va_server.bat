@echo off
REM Run the V/A (valence/arousal) model server from the bundle. Run from repo root.
cd /d "%~dp0..\vcm_website_bundle"
if not exist "checkpoints\va_late_fusion_speech_emotion.joblib" (
  echo ERROR: Model not found. Copy va_late_fusion_speech_emotion.joblib into vcm_website_bundle\checkpoints\
  exit /b 1
)
echo Starting V/A server on http://localhost:5000
python server.py
