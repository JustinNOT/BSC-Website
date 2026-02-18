@echo off
REM Build frontend for production. Run from repo root.
cd /d "%~dp0..\frontend"
echo Installing frontend dependencies...
call npm ci 2>nul || call npm install
if exist .env.production (
  echo Using frontend/.env.production for VITE_API_BASE
) else (
  echo No frontend/.env.production — API will use same origin. Copy frontend\.env.example to .env.production if backend is on another URL.
)
echo Building...
call npm run build
echo Done. Output: frontend\dist\
