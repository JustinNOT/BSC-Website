"""
BSC Web API: VCM (Viewers Comments Model) using SVMPlus pipeline.
Researchers submit a YouTube URL and get comments + emotion predictions.
"""
import os
import re
import json
from pathlib import Path
from collections import Counter
from datetime import datetime

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from starlette.middleware.base import BaseHTTPMiddleware

import joblib
import pandas as pd
from googleapiclient.discovery import build
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from text_utils import expand_emojis_for_emotion

# Paths
BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
STORED_DIR = BASE_DIR / "stored_videos"

# Default sentiment labels (0-4)
SENTIMENT_LABELS = {"0": "neutral", "1": "pleased", "2": "funny", "3": "fear", "4": "sad"}


def _client_ip(request: Request) -> str:
    """Client IP for rate limiting; respects X-Forwarded-For when behind a proxy."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return get_remote_address(request) if request.client else "unknown"


# Rate limits (per IP); override via env if needed
RATE_LIMIT_ANALYZE = os.environ.get("RATE_LIMIT_ANALYZE", "20/minute")
RATE_LIMIT_STORE = os.environ.get("RATE_LIMIT_STORE", "30/minute")
RATE_LIMIT_GENERAL = os.environ.get("RATE_LIMIT_GENERAL", "60/minute")

limiter = Limiter(key_func=_client_ip)

app = FastAPI(
    title="BSC VCM API",
    description="Viewers Comments Model: analyze YouTube video comments and predict emotions.",
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add baseline security headers to all responses."""

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
        return response


app.add_middleware(SecurityHeadersMiddleware)

# CORS: set CORS_ORIGINS to comma-separated list (e.g. https://yourdomain.com); leave unset for "*"
_cors_origins = os.environ.get("CORS_ORIGINS", "").strip()
if _cors_origins and _cors_origins.lower() != "*":
    _origins_list = [o.strip() for o in _cors_origins.split(",") if o.strip()]
else:
    _origins_list = ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Model loading ---
_vectorizer = None
_xgb_model = None
_rf_model = None
_labels = None


def load_models():
    global _vectorizer, _xgb_model, _rf_model, _labels
    if _vectorizer is not None:
        return
    vec_path = MODELS_DIR / "vectorizer.joblib"
    xgb_path = MODELS_DIR / "xgb_model.joblib"
    rf_path = MODELS_DIR / "rf_model.joblib"
    labels_path = MODELS_DIR / "sentiment_labels.json"
    if not vec_path.exists() or not xgb_path.exists():
        raise FileNotFoundError(
            "Models not found. Run: python bsc-vcm/scripts/train_and_save_vcm.py"
        )
    _vectorizer = joblib.load(vec_path)
    _xgb_model = joblib.load(xgb_path)
    _rf_model = joblib.load(rf_path) if rf_path.exists() else None
    if labels_path.exists():
        with open(labels_path) as f:
            _labels = json.load(f)
    else:
        _labels = SENTIMENT_LABELS


def get_label(code: int) -> str:
    return _labels.get(str(code), "unknown")


def _safe_emotion_folder(label: str | None) -> str:
    """Sanitize emotion label for use as folder name."""
    if not label:
        return "unknown"
    return re.sub(r"[^a-zA-Z0-9_-]+", "_", label.lower())


# --- YouTube ---
def extract_video_id(url: str) -> str | None:
    patterns = [
        r"(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})",
        r"(?:youtu\.be\/)([a-zA-Z0-9_-]{11})",
        r"(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})",
    ]
    for p in patterns:
        m = re.search(p, url)
        if m:
            return m.group(1)
    if re.match(r"^[a-zA-Z0-9_-]{11}$", url.strip()):
        return url.strip()
    return None


# YouTube API key — must be set via YOUTUBE_API_KEY env or backend/.env
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "").strip()


def get_youtube_client():
    api_key = YOUTUBE_API_KEY or os.environ.get("YOUTUBE_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="YOUTUBE_API_KEY environment variable is not set.",
        )
    return build("youtube", "v3", developerKey=api_key)


# In-memory cache for YouTube comments (saves API quota for repeated requests)
_comment_cache: dict[str, list] = {}
_comment_cache_max_size = int(os.environ.get("VCM_COMMENT_CACHE_SIZE", "200"))


# Must match build_stage2_dataset.py: fetch 100, sort by likes, use top 30 for Stage 2. Changing this would change the count distribution and hurt Stage 2 accuracy unless you retrain.
DEFAULT_FETCH_COMMENT_LIMIT = 100

def fetch_comments(video_id: str, max_results: int = None):
    if max_results is None:
        max_results = DEFAULT_FETCH_COMMENT_LIMIT
    if os.environ.get("VCM_DISABLE_CACHE", "").lower() in ("1", "true", "yes"):
        return _fetch_comments_uncached(video_id, max_results)
    if video_id in _comment_cache:
        cached = _comment_cache[video_id]
        return cached[:max_results] if len(cached) >= max_results else cached
    comments = _fetch_comments_uncached(video_id, max_results)
    _comment_cache[video_id] = comments
    if len(_comment_cache) > _comment_cache_max_size:
        # Drop oldest entry (first key)
        _comment_cache.pop(next(iter(_comment_cache)))
    return comments


def _fetch_comments_uncached(video_id: str, max_results: int = 100):
    youtube = get_youtube_client()
    comments = []
    next_page_token = None
    while True:
        try:
            to_fetch = min(100, max_results - len(comments))
            if to_fetch <= 0:
                break
            response = (
                youtube.commentThreads()
                .list(
                    part="snippet",
                    videoId=video_id,
                    pageToken=next_page_token,
                    maxResults=to_fetch,
                    textFormat="plainText",
                )
                .execute()
            )
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"YouTube API error: {str(e)}")
        for item in response.get("items", []):
            snip = item["snippet"]["topLevelComment"]["snippet"]
            comments.append({
                "author": snip.get("authorDisplayName", ""),
                "text": snip.get("textDisplay", snip.get("textOriginal", "")),
                "like_count": int(snip.get("likeCount", 0)),
                "published_at": snip.get("publishedAt", ""),
            })
        next_page_token = response.get("nextPageToken")
        if not next_page_token or len(comments) >= max_results:
            break
    return comments


def get_video_title(video_id: str) -> str | None:
    youtube = get_youtube_client()
    try:
        response = (
            youtube.videos()
            .list(part="snippet", id=video_id)
            .execute()
        )
        items = response.get("items", [])
        if items:
            return items[0]["snippet"].get("title", "")
    except Exception:
        pass
    return None


# --- Prediction ---
def predict_comments_and_video(video_id: str, max_comments: int = None):
    if max_comments is None:
        max_comments = DEFAULT_FETCH_COMMENT_LIMIT
    load_models()
    comments = fetch_comments(video_id, max_results=max_comments)
    if not comments:
        return [], None, None, None, None, None, None, None

    df = pd.DataFrame(comments)
    df = df.sort_values("like_count", ascending=False).reset_index(drop=True)

    comment_predictions = []
    valid_preds = []
    for _, row in df.iterrows():
        text = str(row["text"]) if pd.notna(row["text"]) else ""
        if not text.strip():
            continue
        text_for_model = expand_emojis_for_emotion(text)
        X = _vectorizer.transform([text_for_model])
        pred = int(_xgb_model.predict(X)[0])
        if 0 <= pred <= 4:
            valid_preds.append(pred)
        comment_predictions.append({
            "author": row["author"],
            "text": text[:500],
            "like_count": int(row["like_count"]),
            "emotion": get_label(pred),
            "emotion_code": pred,
        })
        if len(valid_preds) >= 30:
            break

    # Only show top 30 by likes (same pool used for Stage 2)
    comment_predictions = comment_predictions[:30]

    video_emotion = None
    video_emotion_code = None
    emotion_percentages = None
    stage2_emotion = None
    stage2_emotion_code = None
    stage2_emotion_2 = None
    stage2_emotion_code_2 = None
    if len(valid_preds) >= 1:
        counts = [valid_preds.count(i) for i in range(5)]
        total = sum(counts)
        if total > 0:
            emotion_percentages = {
                get_label(i): round(100 * counts[i] / total, 1) for i in range(5)
            }
            video_emotion_code = int(max(range(5), key=lambda i: counts[i]))
            video_emotion = get_label(video_emotion_code)
        if _rf_model is not None:
            try:
                X_counts = pd.DataFrame(
                    [counts],
                    columns=[f"Count_{i}" for i in range(5)],
                )
                proba = _rf_model.predict_proba(X_counts)[0]
                classes = _rf_model.classes_
                order = sorted(range(len(proba)), key=lambda i: -proba[i])
                stage2_emotion_code = int(classes[order[0]])
                stage2_emotion = get_label(stage2_emotion_code)
                if len(order) >= 2:
                    stage2_emotion_code_2 = int(classes[order[1]])
                    stage2_emotion_2 = get_label(stage2_emotion_code_2)
            except Exception:
                try:
                    stage2_emotion_code = int(_rf_model.predict(X_counts)[0])
                    stage2_emotion = get_label(stage2_emotion_code)
                except Exception:
                    pass

    return comment_predictions, video_emotion, video_emotion_code, emotion_percentages, stage2_emotion, stage2_emotion_code, stage2_emotion_2, stage2_emotion_code_2


def predict_comments_and_video_with_progress(video_id: str, max_comments: int = None):
    """Same as predict_comments_and_video but yields (progress_message, result_tuple).
    result_tuple is None until the end.
    """
    if max_comments is None:
        max_comments = DEFAULT_FETCH_COMMENT_LIMIT
    yield "Fetching comments from YouTube…", None
    load_models()
    comments = fetch_comments(video_id, max_results=max_comments)
    if not comments:
        yield "No comments found.", ([], None, None, None, None, None, None, None)
        return

    yield f"Got {len(comments)} comments. Loading model…", None
    df = pd.DataFrame(comments)
    df = df.sort_values("like_count", ascending=False).reset_index(drop=True)

    comment_predictions = []
    valid_preds = []
    target = 30
    for idx, (_, row) in enumerate(df.iterrows()):
        if len(valid_preds) >= target:
            break
        text = str(row["text"]) if pd.notna(row["text"]) else ""
        if not text.strip():
            continue
        text_for_model = expand_emojis_for_emotion(text)
        X = _vectorizer.transform([text_for_model])
        pred = int(_xgb_model.predict(X)[0])
        if 0 <= pred <= 4:
            valid_preds.append(pred)
        comment_predictions.append({
            "author": row["author"],
            "text": text[:500],
            "like_count": int(row["like_count"]),
            "emotion": get_label(pred),
            "emotion_code": pred,
        })
        if (len(comment_predictions) % 10) == 0 and len(comment_predictions) > 0:
            yield f"Analyzed {len(comment_predictions)} comments…", None

    # Only show top 30 by likes (same pool used for Stage 2)
    comment_predictions = comment_predictions[:30]

    video_emotion = None
    video_emotion_code = None
    emotion_percentages = None
    stage2_emotion = None
    stage2_emotion_code = None
    stage2_emotion_2 = None
    stage2_emotion_code_2 = None
    if len(valid_preds) >= 1:
        yield "Computing final video emotion…", None
        counts = [valid_preds.count(i) for i in range(5)]
        total = sum(counts)
        if total > 0:
            emotion_percentages = {
                get_label(i): round(100 * counts[i] / total, 1) for i in range(5)
            }
            video_emotion_code = int(max(range(5), key=lambda i: counts[i]))
            video_emotion = get_label(video_emotion_code)
        if _rf_model is not None:
            try:
                X_counts = pd.DataFrame(
                    [counts],
                    columns=[f"Count_{i}" for i in range(5)],
                )
                proba = _rf_model.predict_proba(X_counts)[0]
                classes = _rf_model.classes_
                order = sorted(range(len(proba)), key=lambda i: -proba[i])
                stage2_emotion_code = int(classes[order[0]])
                stage2_emotion = get_label(stage2_emotion_code)
                if len(order) >= 2:
                    stage2_emotion_code_2 = int(classes[order[1]])
                    stage2_emotion_2 = get_label(stage2_emotion_code_2)
            except Exception:
                try:
                    stage2_emotion_code = int(_rf_model.predict(X_counts)[0])
                    stage2_emotion = get_label(stage2_emotion_code)
                except Exception:
                    pass

    yield "Done.", (comment_predictions, video_emotion, video_emotion_code, emotion_percentages, stage2_emotion, stage2_emotion_code, stage2_emotion_2, stage2_emotion_code_2)


# --- API ---
class AnalyzeRequest(BaseModel):
    youtube_url: str = Field(..., max_length=500)


# Password required to store videos (researchers must enter this on the site). Set STORE_PASSWORD in .env to override.
STORE_PASSWORD = os.environ.get("STORE_PASSWORD", "SBRH8888")
# Password required to delete stored videos. Set DELETE_PASSWORD in .env to override.
DELETE_PASSWORD = os.environ.get("DELETE_PASSWORD", "SBRH6666")


class StoreRequest(BaseModel):
    store_password: str
    video_id: str
    title: str | None = ""
    video_emotion: str | None = None
    video_emotion_code: int | None = None
    stage2_emotion: str | None = None
    stage2_emotion_code: int | None = None
    stage2_emotion_2: str | None = None
    stage2_emotion_code_2: int | None = None
    emotion_percentages: dict[str, float] | None = None
    comment_count: int | None = None
    store_under_emotion: str | None = None  # e.g. "sad" to store under 1st or 2nd dominant


@app.get("/")
def root():
    return {
        "name": "BSC VCM API",
        "docs": "/docs",
        "analyze": "POST /api/analyze with body: { \"youtube_url\": \"...\" }",
    }


@app.get("/api/health")
def health():
    try:
        load_models()
        return {"status": "ok", "models_loaded": True}
    except FileNotFoundError as e:
        return {"status": "degraded", "models_loaded": False, "message": str(e)}


def _stream_analyze_gen(video_id: str, title: str | None):
    for msg, result in predict_comments_and_video_with_progress(video_id):
        if result is not None:
            comments_with_emotions, video_emotion, video_emotion_code, emotion_percentages, stage2_emotion, stage2_emotion_code, stage2_emotion_2, stage2_emotion_code_2 = result
            print(f"  [API] Done. {len(comments_with_emotions)} comments, stage2: {stage2_emotion}, 2nd: {stage2_emotion_2}", flush=True)
            yield json.dumps({
                "type": "result",
                "data": {
                    "video_id": video_id,
                    "title": title or "",
                    "video_emotion": video_emotion,
                    "video_emotion_code": video_emotion_code,
                    "emotion_percentages": emotion_percentages,
                    "stage2_emotion": stage2_emotion,
                    "stage2_emotion_code": stage2_emotion_code,
                    "stage2_emotion_2": stage2_emotion_2,
                    "stage2_emotion_code_2": stage2_emotion_code_2,
                    "comments": comments_with_emotions,
                    "comment_count": len(comments_with_emotions),
                },
            }) + "\n"
            return
        print(f"  [API] {msg}", flush=True)
        yield json.dumps({"type": "progress", "message": msg}) + "\n"


@app.post("/api/analyze")
@limiter.limit(RATE_LIMIT_ANALYZE)
def analyze(http_request: Request, request: AnalyzeRequest):
    video_id = extract_video_id(request.youtube_url)
    if not video_id:
        raise HTTPException(status_code=400, detail="Invalid YouTube URL or video ID")
    title = get_video_title(video_id)
    comments_with_emotions, video_emotion, video_emotion_code, emotion_percentages, stage2_emotion, stage2_emotion_code, stage2_emotion_2, stage2_emotion_code_2 = predict_comments_and_video(
        video_id
    )
    return {
        "video_id": video_id,
        "title": title or "",
        "video_emotion": video_emotion,
        "video_emotion_code": video_emotion_code,
        "emotion_percentages": emotion_percentages,
        "stage2_emotion": stage2_emotion,
        "stage2_emotion_code": stage2_emotion_code,
        "stage2_emotion_2": stage2_emotion_2,
        "stage2_emotion_code_2": stage2_emotion_code_2,
        "comments": comments_with_emotions,
        "comment_count": len(comments_with_emotions),
    }


@app.post("/api/store")
@limiter.limit(RATE_LIMIT_STORE)
def store_video(http_request: Request, request: StoreRequest):
    """Store the current video's summary under a folder named by its emotion.

    Requires correct store_password. Files are written to
    backend/stored_videos/<emotion>/*.json so researchers can browse by emotion.
    """
    if request.store_password != STORE_PASSWORD:
        raise HTTPException(status_code=401, detail="Incorrect password")
    if not request.video_id:
        raise HTTPException(status_code=400, detail="video_id is required")

    # Use chosen emotion folder, or default to 1st dominant.
    main_label = (request.store_under_emotion or request.stage2_emotion or request.video_emotion or "unknown").strip()
    if not main_label:
        main_label = "unknown"
    folder = STORED_DIR / _safe_emotion_folder(main_label)
    folder.mkdir(parents=True, exist_ok=True)

    ts = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    filename = f"{request.video_id}_{ts}.json"
    path = folder / filename

    payload = {
        "stored_at_utc": ts,
        "video_id": request.video_id,
        "title": request.title or "",
        "video_emotion": request.video_emotion,
        "video_emotion_code": request.video_emotion_code,
        "stage2_emotion": request.stage2_emotion,
        "stage2_emotion_code": request.stage2_emotion_code,
        "stage2_emotion_2": request.stage2_emotion_2,
        "stage2_emotion_code_2": request.stage2_emotion_code_2,
        "emotion_percentages": request.emotion_percentages,
        "comment_count": request.comment_count,
    }

    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    return {
        "status": "ok",
        "stored_in": str(folder.relative_to(BASE_DIR)),
        "filename": filename,
        "emotion_folder": _safe_emotion_folder(main_label),
    }


@app.get("/api/stored")
@limiter.limit(RATE_LIMIT_GENERAL)
def list_stored(http_request: Request):
    """List all stored videos grouped by emotion category.
    Returns { "neutral": [ { video_id, title, stored_at_utc } ], "sad": [...], ... }.
    """
    out = {}
    if not STORED_DIR.exists():
        return out
    for folder in sorted(STORED_DIR.iterdir()):
        if not folder.is_dir():
            continue
        cat = folder.name
        out[cat] = []
        for path in sorted(folder.glob("*.json")):
            try:
                with path.open(encoding="utf-8") as f:
                    data = json.load(f)
                out[cat].append({
                    "video_id": data.get("video_id", ""),
                    "title": data.get("title", ""),
                    "stored_at_utc": data.get("stored_at_utc", ""),
                })
            except (json.JSONDecodeError, OSError):
                continue
    return out


class DeleteStoredRequest(BaseModel):
    delete_password: str
    emotion: str
    video_id: str
    stored_at_utc: str


@app.post("/api/stored/delete")
@limiter.limit(RATE_LIMIT_GENERAL)
def delete_stored(http_request: Request, request: DeleteStoredRequest):
    """Delete one stored video. Requires delete password."""
    if request.delete_password != DELETE_PASSWORD:
        raise HTTPException(status_code=401, detail="Incorrect delete password")
    video_id = str(request.video_id or "").strip()
    stored_at_utc = str(request.stored_at_utc or "").strip()
    if not video_id or not stored_at_utc:
        raise HTTPException(status_code=400, detail="video_id and stored_at_utc required")
    # Filename is always video_id + _ + stored_at_utc + .json
    filename = f"{video_id}_{stored_at_utc}.json"
    # Find the file by scanning all emotion folders (avoids folder-name mismatch)
    found_path = None
    if STORED_DIR.exists():
        for folder in STORED_DIR.iterdir():
            if not folder.is_dir():
                continue
            candidate = folder / filename
            if candidate.is_file():
                found_path = candidate
                break
    if found_path is None:
        raise HTTPException(
            status_code=404,
            detail=f"Stored video not found: {filename}",
        )
    try:
        found_path.unlink()
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Could not delete file: {e}")
    return {"status": "ok", "deleted": filename}


@app.post("/api/analyze-stream")
@limiter.limit(RATE_LIMIT_ANALYZE)
def analyze_stream(http_request: Request, request: AnalyzeRequest):
    video_id = extract_video_id(request.youtube_url)
    if not video_id:
        raise HTTPException(status_code=400, detail="Invalid YouTube URL or video ID")

    def gen():
        try:
            print(f"  [API] Analyze request for video_id={video_id}", flush=True)
            print(f"  [API] Fetching video info…", flush=True)
            yield json.dumps({"type": "progress", "message": "Fetching video info…"}) + "\n"
            title = get_video_title(video_id)
            for line in _stream_analyze_gen(video_id, title):
                yield line
        except Exception as e:
            print(f"  [API] Error: {e}", flush=True)
            yield json.dumps({"type": "error", "detail": str(e)}) + "\n"

    return StreamingResponse(
        gen(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
