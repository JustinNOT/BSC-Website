# Launch the BSC VCM site — step by step

Everything that can be done **in the repo is already done**. Follow only the steps below that you do **outside the code** (hosting, env, running commands on a server).

---

## What’s already done (no action needed)

- Backend and frontend code are ready for production.
- Security: CORS (configurable), rate limiting, security headers, input validation.
- Deploy configs: `deploy/nginx.conf.example`, `deploy/bsc-vcm-backend.service.example`.
- Build scripts: `scripts/build_production.bat` / `scripts/build_production.sh`, `scripts/run_backend.bat` / `scripts/run_backend.sh`.
- Env templates: `backend/.env.example`, `frontend/.env.example`.

---

## Choose one path

- **Path A — One server (VPS)**  
  You have (or will create) a Linux server (e.g. DigitalOcean, Linode). The same machine serves the frontend and runs the backend. Best if you want full control and one place to manage.

- **Path B — Hosting services (no server)**  
  Backend on Railway/Render/Fly.io, frontend on Vercel/Netlify. No server to maintain; you configure each service in their dashboard.

---

# Path A — One server (VPS)

Do these steps **in order**, on your machine and on the server where noted.

### Step A1. Get a server and a domain (you do this)

1. **Rent a VPS** (e.g. [DigitalOcean](https://www.digitalocean.com/), [Linode](https://www.linode.com/)). Create a droplet/instance with Ubuntu 22.04 (or similar). Note the **IP address**.
2. **Domain (optional but recommended):**  
   - Either buy a domain (e.g. from Namecheap, Google Domains, Cloudflare) and add an **A record** pointing to your server IP.  
   - Or skip and use the server IP as the URL (e.g. `http://123.45.67.89`) for testing; you can add a domain and HTTPS later.

### Step A2. Backend .env and API key (you do this)

1. On your **local machine**, in this repo: copy `backend/.env.example` to `backend/.env` (if you haven’t already).
2. Open `backend/.env` and set:
   - `YOUTUBE_API_KEY` — your YouTube Data API v3 key (get from [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → Create API key; enable YouTube Data API v3).
   - When you have your public URL, add: `CORS_ORIGINS=https://yourdomain.com` (or `https://YOUR_SERVER_IP` if no domain yet; use `http` only for quick tests).
3. **Do not commit** `backend/.env` (it’s in `.gitignore`). You’ll copy it to the server or recreate it there (Step A5).

### Step A3. Trained models on the server (you do this)

The backend needs these files in `backend/models/`:

- `vectorizer.joblib`
- `xgb_model.joblib`
- `sentiment_labels.json`
- (optional) `rf_model.joblib`

**If you already trained** (e.g. on your PC): copy the `backend/models/` folder (with the `.joblib` and `sentiment_labels.json` files) to the server into the repo’s `backend/models/` path.

**If you haven’t trained yet:** train on your machine (see README “Train the VCM model”), then copy `backend/models/` to the server as above.

### Step A4. Clone repo and install stack on the server (you do this)

SSH into your server, then run (replace `/var/www/VCM` with your chosen path):

```bash
sudo apt update
sudo apt install -y python3 python3-pip python3-venv nginx git

# Install Node 18 (for building frontend)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Clone repo (use your repo URL; if private, use a deploy key or HTTPS with token)
sudo mkdir -p /var/www
sudo git clone https://github.com/YOUR_USERNAME/bsc-vcm.git /var/www/VCM
sudo chown -R $USER:$USER /var/www/VCM
cd /var/www/VCM
```

### Step A5. Backend .env on the server (you do this)

On the **server**:

```bash
cd /var/www/VCM/backend
cp .env.example .env
nano .env   # or vi
```

Set at least:

- `YOUTUBE_API_KEY=your-actual-key`
- `CORS_ORIGINS=https://yourdomain.com` (or your server IP URL when you have it)

Save and exit. Do not commit `.env`.

### Step A6. Backend venv and run (you do this)

On the **server**:

```bash
cd /var/www/VCM/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
# Test run (Ctrl+C to stop after testing)
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

If that works, stop it (Ctrl+C). Then run it under systemd so it stays up:

```bash
sudo cp /var/www/VCM/deploy/bsc-vcm-backend.service.example /etc/systemd/system/bsc-vcm-backend.service
sudo nano /etc/systemd/system/bsc-vcm-backend.service
```

Replace every `/path/to/VCM` with `/var/www/VCM`. Ensure `EnvironmentFile=/var/www/VCM/backend/.env` is correct. Set `User=` to the user that owns the repo (e.g. your SSH user, not necessarily `www-data`). If the backend fails to see env vars, use unquoted values in `.env` (e.g. `YOUTUBE_API_KEY=yourkey` without quotes) for systemd. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable bsc-vcm-backend
sudo systemctl start bsc-vcm-backend
sudo systemctl status bsc-vcm-backend
```

### Step A7. Build frontend on the server (you do this)

On the **server** (same server, same domain — so no `VITE_API_BASE`):

```bash
cd /var/www/VCM
npm install --prefix frontend
cd frontend && npm run build && cd ..
```

This creates `frontend/dist/`. If the backend is on the same domain, **do not** set `VITE_API_BASE` (leave it unset so the app uses relative `/api`).

### Step A8. Nginx (you do this)

On the **server**:

```bash
sudo cp /var/www/VCM/deploy/nginx.conf.example /etc/nginx/sites-available/bsc-vcm
sudo nano /etc/nginx/sites-available/bsc-vcm
```

- Replace `your-domain.com` with your domain (or leave as the server’s hostname if you don’t have a domain yet).
- Replace `/path/to/VCM` with `/var/www/VCM`.

Then:

```bash
sudo ln -sf /etc/nginx/sites-available/bsc-vcm /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Open **http://your-server-ip** or **http://yourdomain.com**. You should see the site; “Analyze” will use the backend.

### Step A9. HTTPS with Certbot (you do this, recommended)

On the **server** (only after your domain A record points to this server):

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

Follow the prompts. After that, use **https://yourdomain.com**. Update `CORS_ORIGINS` in `backend/.env` to `https://yourdomain.com` and restart the backend:

```bash
sudo systemctl restart bsc-vcm-backend
```

---

# Path B — Hosting services (no server)

Do these in order.

### Step B1. Backend on Railway / Render / Fly.io (you do this)

1. Create an account on [Railway](https://railway.app/), [Render](https://render.com/), or [Fly.io](https://fly.io/).
2. Create a **new project** and connect this GitHub repo (or upload the repo).
3. Set **root** or **start directory** to `backend` (so it runs from the `backend` folder).
4. Set **build command** (if any): `pip install -r requirements.txt` (or the host’s equivalent).
5. Set **start command**: `uvicorn main:app --host 0.0.0.0 --port $PORT` (use the variable the host gives, often `PORT`).
6. In the service **Environment** / **Variables**, add:
   - `YOUTUBE_API_KEY` = your YouTube API key  
   - `CORS_ORIGINS` = your frontend URL (you’ll set this after deploying the frontend, e.g. `https://your-app.vercel.app`)
7. Upload or ensure **models** are present: the host must have `backend/models/` with `vectorizer.joblib`, `xgb_model.joblib`, `sentiment_labels.json`, and optionally `rf_model.joblib`. Use the host’s “persistent disk” or “volume” if needed, or include the model files in the deployed folder if the host allows.
8. Deploy. Note the **backend URL** (e.g. `https://your-app.up.railway.app`).

### Step B2. Frontend on Vercel / Netlify (you do this)

1. Create an account on [Vercel](https://vercel.com/) or [Netlify](https://www.netlify.com/).
2. **New project** → import this repo.
3. Set **root directory** to `frontend`.
4. **Build command:** `npm run build`  
   **Output / publish directory:** `dist`
5. **Environment variable:** add `VITE_API_BASE` = your backend URL from Step B1 (e.g. `https://your-app.up.railway.app`). No trailing slash.
6. Deploy. Note the **frontend URL** (e.g. `https://bsc-vcm.vercel.app`).

### Step B3. Point backend CORS at frontend (you do this)

In the **backend** project (Railway/Render/Fly.io), set or update the env var:

- `CORS_ORIGINS` = your frontend URL from Step B2 (e.g. `https://bsc-vcm.vercel.app`)

Redeploy the backend if needed. Then open the frontend URL and test Analyze.

### Step B4. Models on hosted backend (you do this)

If the hosting platform doesn’t include your repo’s `backend/models/` (e.g. because `.joblib` is in `.gitignore”), you must either:

- Remove `backend/models/*.joblib` from `.gitignore` and commit the model files (not ideal if they’re large or private), or  
- Use the host’s volume/persistent storage and upload the model files there, or  
- Use a host that runs the build from your repo and allows adding a “models” artifact (e.g. from CI).

Details depend on the host; the backend will fail to start until `vectorizer.joblib` and `xgb_model.joblib` (and `sentiment_labels.json`) are present in `backend/models/` at runtime.

---

# After launch

- Share the site URL with researchers.
- Optionally change the store/delete passwords in `backend/.env` (see `backend/.env.example`).
- Monitor YouTube API quota (see `backend/API_QUOTA.md` and `backend/PROTECT_API_QUOTA.md`).

---

# Quick reference

| You need to…              | Where / how |
|---------------------------|-------------|
| Get YouTube API key       | Google Cloud Console → APIs & Services → Credentials → API key; enable YouTube Data API v3 |
| Set backend env vars      | `backend/.env` (YOUTUBE_API_KEY, CORS_ORIGINS) or host’s env dashboard |
| Put trained models        | `backend/models/` on the machine or image that runs the backend |
| Build frontend (same server) | On server: `cd repo; (cd frontend && npm install && npm run build)` |
| Build frontend (different host) | Set `VITE_API_BASE` then `npm run build` in `frontend` |
| Run backend (VPS)         | systemd unit from `deploy/bsc-vcm-backend.service.example` |
| Serve + HTTPS (VPS)       | Nginx from `deploy/nginx.conf.example`, then Certbot |
