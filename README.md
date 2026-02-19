# BSC — Brain Stimuli Curation

A single repo with a **fully functioning website** for researchers: enter any YouTube video URL and get comments plus **emotion predictions** from the **VCM (Viewers Comments Model)** using the SVMPlus pipeline. MSA (Liris Accede) integration is planned for later.

## What’s in this repo

- **VCM (SVMPlus) pipeline** — Same as in `SVMPlusIMDB.ipynb`: (1) Fetch comments for a YouTube video (needs API key). (2) Run each comment through TF-IDF + XGBoost → per-comment emotion. (3) Take top 30 predictions, build count vector, run through Random Forest → **one final emotion for the video**. The website runs this full pipeline.
- **`bsc-vcm/`** — Notebooks and training code (e.g. `SVMPlusIMDB.ipynb`).
- **`backend/`** — FastAPI server: loads trained models, fetches YouTube comments, runs predictions.
- **`frontend/`** — React (Vite) UI: URL input, results table with comments and emotions, MSA placeholder.

## Quick start

### 1. Train the VCM model — Stage 1 and Stage 2 (once)

From the **repo root** (folder that contains `bsc-vcm`, `backend`, `frontend`). Uses `allcomments_labled.csv` and builds Stage 2 data from the current Stage 1 + video labels. Run in one terminal:

```bash
pip install tqdm -q
python bsc-vcm/scripts/train_vcm_tuned.py
python bsc-vcm/scripts/build_stage2_dataset.py
python bsc-vcm/scripts/train_stage2.py
```

- **Stage 1** (~2–5 min): TF-IDF + XGBoost on comments (with emoji/keyword expansion). Saves `backend/models/vectorizer.joblib`, `xgb_model.joblib`, `sentiment_labels.json`.
- **Stage 2 build** (~1 min): Fetches comments per video (YouTube API), runs Stage 1, writes `bsc-vcm/trainingdata/newtest/stage2_from_current_model.csv`.
- **Stage 2 train** (~10 s): Trains RF on counts → video emotion. Saves `backend/models/rf_model.joblib`.

Optional: set `VCM_OVERSAMPLE=0` to disable oversampling of minority classes; set `VCM_TRAINING_CSV` if your labelled CSV is elsewhere.

### 2. Set your YouTube API key (required)

**Yes — you need a YouTube API key.** The pipeline fetches comments from YouTube, so the backend must have a valid key.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create or select a project → enable **YouTube Data API v3**.
2. Create credentials → API key. Restrict it to YouTube Data API v3 if you want.
3. Set the key in the environment where you run the backend:

```bash
# Windows (cmd)
set YOUTUBE_API_KEY=your-key-here

# Or use backend/.env: copy backend/.env.example to backend/.env and set YOUTUBE_API_KEY there.
```

Without this, the "Analyze" request will fail with a message that the key is not set.

### 3. Run the backend

From repo root, in a **first terminal**:

```bash
cd backend
pip install -r requirements.txt -q
python -m uvicorn main:app --reload --port 8000
```

### 4. Run the frontend

From repo root, in a **second terminal**:

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:3000**. Paste a YouTube URL and click **Analyze** to see comments, emotion percentages, and the final video emotion.

**To publish the site for researchers:** see **RESEARCHER_DEPLOY.md** (short checklist of only what you need to do).

## API

- **POST /api/analyze** — Body: `{ "youtube_url": "https://www.youtube.com/watch?v=..." }`. Returns video title, overall emotion (if RF model is present), and a list of comments with per-comment `emotion` and `emotion_code`.
- **GET /api/health** — Reports whether models are loaded.

## MSA (Liris Accede) — valence/arousal

The **MSA** section (on the Analyze page, below results) lets you upload an MP4 and see a valence/arousal timeline from the bundle in `vcm_website_bundle/` (model: `va_late_fusion_speech_emotion.joblib`).

1. **Run the V/A server** (separate from the main VCM backend), from repo root:
   - Windows: `scripts\run_va_server.bat`
   - Linux/macOS: `bash scripts/run_va_server.sh`
   - First time: `cd vcm_website_bundle && pip install -r requirements.txt`
   - The model file must be in `vcm_website_bundle/checkpoints/va_late_fusion_speech_emotion.joblib` (see the bundle README).
2. With the main backend and frontend running, scroll to **MSA (Liris Accede)** on the Analyze page, upload an MP4, and view the video and charts.

The V/A server runs on port 5000. To use a different URL in production, set `VITE_VA_API_BASE` when building the frontend.

## Model accuracy

VCM uses the SVMPlus pipeline (XGBoost on TF-IDF for comments, Random Forest on count features for video-level). Test accuracy on the comment classifier is ~68% (see `bsc-vcm/sourcecodeai/notebooks/SVMPlusIMDB.ipynb`).
