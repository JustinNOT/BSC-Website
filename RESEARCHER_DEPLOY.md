# Publish the BSC VCM site (for researchers)

Everything is prepared in the repo. You only need to do the steps below.

---

## What you need to do

### 1. Get a YouTube API key (required)

- Go to [Google Cloud Console](https://console.cloud.google.com/) → create or select a project.
- Enable **YouTube Data API v3** (APIs & Services → Library → search “YouTube Data API v3” → Enable).
- Create credentials: APIs & Services → Credentials → Create credentials → API key.
- (Optional) Restrict the key to “YouTube Data API v3” and optionally to your server IP.

---

### 2. Set the API key on the machine that runs the backend

**Option A — Use a `.env` file (recommended)**

- In the repo, go to `backend/`.
- Copy `backend/.env.example` to `backend/.env`.
- Open `backend/.env` and set:
  ```bash
  YOUTUBE_API_KEY=paste-your-key-here
  ```
- Do not commit `.env` (it is in `.gitignore`).

**Option B — Set an environment variable**

- On Windows (PowerShell): `$env:YOUTUBE_API_KEY = "your-key"`
- On Linux/macOS: `export YOUTUBE_API_KEY=your-key`

---

### 3. Choose where to host

**Option A — One server (VPS, e.g. DigitalOcean, Linode)**

- You will: create a server, clone the repo, install Node and Python, run the build script, run the backend, and set up Nginx (and optionally SSL).  
- Full steps are in **Section 5** below.

**Option B — Hosting services (no server)**

- **Backend:** Deploy the `backend/` folder to Railway, Render, or Fly.io (they run `uvicorn` and read env vars).
- **Frontend:** Deploy the `frontend/` folder to Vercel or Netlify (build command: `npm run build`, publish: `dist`). Set `VITE_API_BASE` to your backend URL in the frontend host’s environment variables.
- You will: create accounts, connect the repo, set `YOUTUBE_API_KEY` (and `VITE_API_BASE` for frontend), and deploy.

---

### 4. Build the frontend (any time you deploy)

From the **repo root**:

- **Windows:** run `scripts\build_production.bat`
- **Linux/macOS:** run `bash scripts/build_production.sh`

This creates `frontend/dist/`. If your backend is on a **different URL** than the frontend, create `frontend/.env.production` (from `frontend/.env.example`) and set `VITE_API_BASE=https://your-backend-url.com` before building.

---

### 5. One-server setup (VPS) — only if you chose Option A in step 3

Do these on your server (replace paths and domain with yours):

1. **Clone repo and install**
   - Clone this repo to e.g. `/var/www/VCM`.
   - On the server: install Python 3.10+, Node 18+, and Nginx.

2. **Backend**
   - Copy `backend/.env.example` to `backend/.env` and set `YOUTUBE_API_KEY` (step 2).
   - Create a virtualenv in `backend/`: `python -m venv venv`, then `venv/bin/pip install -r requirements.txt` (or use `scripts/run_backend.sh` which uses system Python if you prefer).
   - Run the backend: from repo root run `bash scripts/run_backend.sh`, or run uvicorn from `backend/` with `venv` activated. To keep it running: copy `deploy/bsc-vcm-backend.service.example` to `/etc/systemd/system/bsc-vcm-backend.service`, edit paths and `YOUTUBE_API_KEY`, then:
     ```bash
     sudo systemctl daemon-reload && sudo systemctl enable bsc-vcm-backend && sudo systemctl start bsc-vcm-backend
     ```

3. **Frontend**
   - From repo root run the build script (step 4). Do **not** set `VITE_API_BASE` (same server).

4. **Nginx**
   - Copy `deploy/nginx.conf.example` to e.g. `/etc/nginx/sites-available/bsc-vcm`.
   - Edit: replace `your-domain.com` and `/path/to/VCM` with your domain and repo path (e.g. `/var/www/VCM`).
   - Enable: `sudo ln -s /etc/nginx/sites-available/bsc-vcm /etc/nginx/sites-enabled/`
   - Test: `sudo nginx -t && sudo systemctl reload nginx`

5. **HTTPS (recommended)**
   - Run: `sudo certbot --nginx -d your-domain.com`

After this, researchers can open `https://your-domain.com`, paste a YouTube URL, and use Analyze / Store.

---

### 6. Optional: security and CORS

- Set `CORS_ORIGINS=https://your-domain.com` in `backend/.env` so only your frontend can call the API (recommended when live).
- Rate limiting is on by default (20 analyze requests per IP per minute, 30 store per minute). To change, set `RATE_LIMIT_ANALYZE`, `RATE_LIMIT_STORE`, or `RATE_LIMIT_GENERAL` in `.env` (e.g. `30/minute`).

### 7. Optional: change the store password

Researchers must enter a password to use “Store this video.” The default is in the code. To override without editing code, set in `backend/.env`:

```bash
STORE_PASSWORD=your-secret-password
```

Share this password only with researchers who should be able to store videos.

---

## Quick reference

| Task | What to run / where |
|------|----------------------|
| Build frontend | From repo root: `scripts/build_production.bat` (Windows) or `bash scripts/build_production.sh` (Linux/macOS) |
| Run backend | From repo root: `scripts/run_backend.bat` or `bash scripts/run_backend.sh` (after setting `YOUTUBE_API_KEY` in `backend/.env`) |
| Nginx config | `deploy/nginx.conf.example` |
| CORS / rate limits | `backend/.env.example` (CORS_ORIGINS, RATE_LIMIT_*) |
| systemd unit | `deploy/bsc-vcm-backend.service.example` |
| Env examples | `backend/.env.example`, `frontend/.env.example` |

For more detail (CORS, custom domains, quota), see `DEPLOY.md`.
