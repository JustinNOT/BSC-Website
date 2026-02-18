@echo off
REM Run backend for production (or local testing). Run from repo root. Set YOUTUBE_API_KEY in env or in backend\.env (use a tool that loads .env, or set manually).
cd /d "%~dp0..\backend"
echo Checking YOUTUBE_API_KEY...
python -c "import os; from dotenv import load_dotenv; load_dotenv(); exit(0 if os.environ.get('YOUTUBE_API_KEY') else 1)" 2>nul
if errorlevel 1 (
  echo ERROR: YOUTUBE_API_KEY is not set. Copy backend\.env.example to backend\.env and set YOUTUBE_API_KEY.
  exit /b 1
)
echo Starting backend on http://0.0.0.0:8000
python -m uvicorn main:app --host 0.0.0.0 --port 8000
