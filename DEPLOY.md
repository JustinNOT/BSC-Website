# Making the website public

Steps to put the BSC VCM site on the internet so researchers can use it.

**Start here:** For a short list of only the tasks you need to do, see **RESEARCHER_DEPLOY.md**.

---

## 1. Choose how to host

You need two things live:

- **Backend** — Python (FastAPI), runs 24/7, needs your **models** and **YouTube API key**.
- **Frontend** — Static site (built with `npm run build`), can be on the same server or a separate host.

**Common setups:**

| Option | Backend | Frontend | Notes |
|--------|--------|----------|--------|
| **A. Single server** | Same machine as frontend | Nginx (or similar) serves built React + proxies `/api` to uvicorn | One VPS (e.g. DigitalOcean, Linode). Full control. |
| **B. Separate hosts** | Railway, Render, Fly.io | Vercel or Netlify | Backend and frontend have different URLs; frontend must call backend URL (see step 4). |

---

## 2. Prepare the backend for production

On the machine or service that will run the backend:

1. **Copy your trained models** into `backend/models/`:
   - `vectorizer.joblib`
   - `xgb_model.joblib`
   - `rf_model.joblib` (optional)
   - `sentiment_labels.json`

2. **Set environment variables** (no hardcoded secrets in code):
   - `YOUTUBE_API_KEY` — Your YouTube Data API v3 key (required for fetching comments).
   - Optionally: `VCM_COMMENT_CACHE_SIZE`, `VCM_DISABLE_CACHE` (see `backend/API_QUOTA.md`).
   - **Security (recommended for production):** Set `CORS_ORIGINS` to your frontend URL(s), comma-separated (e.g. `https://yourdomain.com`). This restricts which sites can call your API. Rate limits apply per IP by default (20 analyze requests/minute, 30 store/minute); override with `RATE_LIMIT_ANALYZE`, `RATE_LIMIT_STORE`, `RATE_LIMIT_GENERAL` if needed (see `backend/.env.example`).

3. **Install and run:**
   ```bash
   cd backend
   pip install -r requirements.txt
   python -m uvicorn main:app --host 0.0.0.0 --port 8000
   ```
   Use a process manager (systemd, supervisor) or your host’s start command so it restarts on failure. For production you may want `--workers 1` and no `--reload`.

4. **Optional:** Put the backend behind a reverse proxy (Nginx, Caddy) with HTTPS (e.g. Let’s Encrypt).

---

## 3. Build and deploy the frontend

1. **Point the frontend at your backend** (if backend is on a different URL):
   - Create a file `frontend/.env.production` (and add it to `.gitignore` if it contains secrets):
     ```
     VITE_API_BASE=https://your-backend-url.com
     ```
   - Replace `https://your-backend-url.com` with your real backend URL (no trailing slash).

2. **Build:**
   ```bash
   cd frontend
   npm install
   npm run build
   ```
   Output is in `frontend/dist/`.

3. **Deploy the contents of `dist/`:**
   - **Vercel / Netlify:** Connect the repo, set root to `frontend`, build command `npm run build`, publish directory `dist`. Set `VITE_API_BASE` in the host’s environment (e.g. Vercel → Settings → Environment variables).
   - **Same server as backend:** Copy `dist/*` to a folder and serve it with Nginx (or serve the backend from the same origin and proxy `/api` to uvicorn; then you don’t need `VITE_API_BASE`).

---

## 4. Frontend → backend URL (when they’re on different hosts)

If the frontend is on e.g. `https://bsc.example.com` and the backend on `https://api.example.com`:

1. **Backend:** Set `CORS_ORIGINS=https://bsc.example.com` (your frontend URL) in the backend environment so only your site can call the API. If unset, all origins are allowed (`*`).

2. **Frontend:** Set `VITE_API_BASE=https://api.example.com` (your backend URL) before `npm run build`. The built app will call that URL for `/api/analyze`, `/api/store`, etc.

3. **Build again** after changing `VITE_API_BASE` so the new URL is baked into the bundle.

---

## 5. Checklist before going public

- [ ] Backend has `vectorizer.joblib`, `xgb_model.joblib`, and (if used) `rf_model.joblib` in `backend/models/`.
- [ ] `YOUTUBE_API_KEY` is set on the backend (and not in the repo).
- [ ] Frontend build used the correct `VITE_API_BASE` if backend is on another URL.
- [ ] HTTPS is enabled (via your host or a reverse proxy).
- [ ] **Security:** Set `CORS_ORIGINS` to your frontend URL in production. Rate limiting is on by default (per IP).
- [ ] You’ve read `backend/PROTECT_API_QUOTA.md` and (optional) set quota alerts or key restrictions.
- [ ] Storing password is only shared with researchers who should be able to store (`backend/main.py`: `STORE_PASSWORD`).

---

## 6. Optional: custom domain

- **Backend:** Set your host’s custom domain (e.g. `api.yourproject.com`) in the hosting dashboard and point DNS (A/CNAME) as instructed.
- **Frontend:** Same idea (e.g. `app.yourproject.com` or `yourproject.com`). Set `VITE_API_BASE` to your backend domain and rebuild.

---

## 7. Quick reference: same-server setup (e.g. one VPS)

1. On the VPS: clone repo, install backend deps, copy models into `backend/models/`, set `YOUTUBE_API_KEY`.
2. Run backend: `uvicorn main:app --host 0.0.0.0 --port 8000` (via systemd or similar).
3. Build frontend (with `VITE_API_BASE` empty or unset if you’ll proxy `/api` from the same domain).
4. Install Nginx; serve the frontend `dist/` as the default site and proxy `location /api { proxy_pass http://127.0.0.1:8000; }`.
5. Add SSL (e.g. Certbot) and restart Nginx.

After that, the site is public at your server’s domain or IP (with HTTPS if you added SSL).
