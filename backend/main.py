"""
BSC Web API: VCM (Viewers Comments Model) using SVMPlus pipeline.
Researchers submit a YouTube URL and get comments + emotion predictions.
"""
import os
import re
import json
from pathlib import Path
from collections import Counter

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import joblib
import pandas as pd
from googleapiclient.discovery import build

from text_utils import expand_emojis_for_emotion

# Paths
BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"

# Default sentiment labels (0-4)
SENTIMENT_LABELS = {"0": "neutral", "1": "pleased", "2": "funny", "3": "fear", "4": "sad"}

app = FastAPI(
    title="BSC VCM API",
    description="Viewers Comments Model: analyze YouTube video comments and predict emotions.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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


# YouTube API key (or set YOUTUBE_API_KEY env var to override)
YOUTUBE_API_KEY = "AIzaSyBY_PfdJBJGtmzVJpE9hWZW_CUROhyc24Q"


def get_youtube_client():
    api_key = os.environ.get("YOUTUBE_API_KEY", YOUTUBE_API_KEY or "").strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="YOUTUBE_API_KEY environment variable is not set.",
        )
    return build("youtube", "v3", developerKey=api_key)


# In-memory cache for YouTube comments (saves API quota for repeated requests)
_comment_cache: dict[str, list] = {}
_comment_cache_max_size = int(os.environ.get("VCM_COMMENT_CACHE_SIZE", "200"))


def fetch_comments(video_id: str, max_results: int = 100):
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
            response = (
                youtube.commentThreads()
                .list(
                    part="snippet",
                    videoId=video_id,
                    pageToken=next_page_token,
                    maxResults=min(max_results, 100),
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
def predict_comments_and_video(video_id: str, max_comments: int = 100):
    load_models()
    comments = fetch_comments(video_id, max_results=max_comments)
    if not comments:
        return [], None, None, None, None, None

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

    video_emotion = None
    video_emotion_code = None
    emotion_percentages = None
    stage2_emotion = None
    stage2_emotion_code = None
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
                stage2_emotion_code = int(_rf_model.predict(X_counts)[0])
                stage2_emotion = get_label(stage2_emotion_code)
            except Exception:
                pass

    return comment_predictions, video_emotion, video_emotion_code, emotion_percentages, stage2_emotion, stage2_emotion_code


def predict_comments_and_video_with_progress(video_id: str, max_comments: int = 100):
    """Same as predict_comments_and_video but yields (progress_message, result_tuple).
    result_tuple is None until the end.
    """
    yield "Fetching comments from YouTube…", None
    load_models()
    comments = fetch_comments(video_id, max_results=max_comments)
    if not comments:
        yield "No comments found.", ([], None, None, None, None, None)
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

    video_emotion = None
    video_emotion_code = None
    emotion_percentages = None
    stage2_emotion = None
    stage2_emotion_code = None
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
                stage2_emotion_code = int(_rf_model.predict(X_counts)[0])
                stage2_emotion = get_label(stage2_emotion_code)
            except Exception:
                pass

    yield "Done.", (comment_predictions, video_emotion, video_emotion_code, emotion_percentages, stage2_emotion, stage2_emotion_code)


# --- API ---
class AnalyzeRequest(BaseModel):
    youtube_url: str


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
            comments_with_emotions, video_emotion, video_emotion_code, emotion_percentages, stage2_emotion, stage2_emotion_code = result
            print(f"  [API] Done. {len(comments_with_emotions)} comments, prominent: {video_emotion}, stage2: {stage2_emotion}", flush=True)
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
                    "comments": comments_with_emotions,
                    "comment_count": len(comments_with_emotions),
                },
            }) + "\n"
            return
        print(f"  [API] {msg}", flush=True)
        yield json.dumps({"type": "progress", "message": msg}) + "\n"


@app.post("/api/analyze")
def analyze(request: AnalyzeRequest):
    video_id = extract_video_id(request.youtube_url)
    if not video_id:
        raise HTTPException(status_code=400, detail="Invalid YouTube URL or video ID")
    title = get_video_title(video_id)
    comments_with_emotions, video_emotion, video_emotion_code, emotion_percentages, stage2_emotion, stage2_emotion_code = predict_comments_and_video(
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
        "comments": comments_with_emotions,
        "comment_count": len(comments_with_emotions),
    }


@app.post("/api/analyze-stream")
def analyze_stream(request: AnalyzeRequest):
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
