# Fix YouTube API issues

The app needs **YouTube Data API v3** to fetch comments. Follow these steps.

---

## 1. Create or use a Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or select an existing one).
3. Make sure **billing** is enabled (YouTube API requires it; you get free quota each month).

---

## 2. Enable YouTube Data API v3

1. In Cloud Console go to **APIs & Services** → **Library**.
2. Search for **YouTube Data API v3**.
3. Open it and click **Enable**.

---

## 3. Create an API key

1. Go to **APIs & Services** → **Credentials**.
2. Click **Create credentials** → **API key**.
3. Copy the key. Optionally restrict it:
   - **Application restrictions**: “IP addresses” or “HTTP referrers” if you know your server/domain.
   - **API restrictions**: “Restrict key” and select only **YouTube Data API v3** (recommended).

---

## 4. Use the key in the backend

**Option A – Environment variable (recommended)**

Before starting the backend, set the key:

**Windows (PowerShell):**
```powershell
$env:YOUTUBE_API_KEY = "YOUR_API_KEY_HERE"
cd backend
python -m uvicorn main:app --reload --port 8000
```

**Windows (Command Prompt):**
```cmd
set YOUTUBE_API_KEY=YOUR_API_KEY_HERE
cd backend
python -m uvicorn main:app --reload --port 8000
```

**Linux / macOS:**
```bash
export YOUTUBE_API_KEY="YOUR_API_KEY_HERE"
cd backend
python -m uvicorn main:app --reload --port 8000
```

**Option B – .env file (if you use python-dotenv)**

Create `backend/.env` (and add it to `.gitignore`):

```
YOUTUBE_API_KEY=YOUR_API_KEY_HERE
```

Then load it in `main.py` or run with a tool that loads `.env` (e.g. `uvicorn` with `python-dotenv`).

---

## 5. Typical errors and fixes

| Error | Cause | Fix |
|-------|--------|-----|
| **403 Forbidden** or **API key not valid** | Key invalid, revoked, or API not enabled | Create a new key, enable YouTube Data API v3, and set `YOUTUBE_API_KEY`. |
| **403 The request cannot be completed because you have exceeded your quota** | Daily quota (e.g. 10,000 units) used up | Wait until next day, or in Cloud Console request a quota increase. |
| **404 videoNotFound** or **comments disabled** | Video doesn’t exist or comments are disabled | Try another video; the app will skip that one. |
| **503 YOUTUBE_API_KEY environment variable is not set** | No key provided | Set `YOUTUBE_API_KEY` as in step 4. |

---

## 6. Check quota

- **APIs & Services** → **Dashboard** → **YouTube Data API v3** → **Quotas**.
- One “Analyze” call ≈ 2 units (comments + video title). Default 10,000 units/day ≈ 5,000 analyses per day if not cached.

---

**Security:** Do not commit your API key to Git. Use the env var or a `.env` file that is in `.gitignore`.
