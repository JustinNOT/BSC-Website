"""
Standalone Flask API for V/A model: POST /api/upload (MP4 -> timeline), GET /uploads/<name>.
Run from this bundle folder (no dependency on Git-LA). All code and checkpoint live inside this folder.

  pip install -r requirements.txt
  python server.py

Crashes are often due to: (1) Out-of-memory on long or high-res videos, (2) only one inference
at a time is safe on small instances, (3) disk full from many uploads.
"""
import os
from pathlib import Path
import sys
import uuid
import json
import threading
import queue

# Bundle root = folder containing this server.py
BUNDLE_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(BUNDLE_ROOT))
sys.path.insert(0, str(BUNDLE_ROOT / "scripts"))

from flask import Flask, jsonify, request, send_from_directory, Response

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024  # 500 MB

UPLOAD_DIR = BUNDLE_ROOT / "uploads"
CKPT_DIR = BUNDLE_ROOT / "checkpoints"

# Only one inference at a time to avoid OOM (PyTorch + frames are memory-heavy)
_inference_lock = threading.Lock()
# Max video duration in seconds (avoids OOM on very long videos). Set VA_MAX_DURATION_SEC=0 to disable.
MAX_VIDEO_DURATION_SEC = int(os.environ.get("VA_MAX_DURATION_SEC", "600"))  # default 10 min


@app.after_request
def cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


@app.route("/api/upload", methods=["POST", "OPTIONS"])
def api_upload():
    if request.method == "OPTIONS":
        return "", 204
    if "video" not in request.files and "file" not in request.files:
        return jsonify({"error": "no_file"}), 400
    f = request.files.get("video") or request.files.get("file")
    if not f or f.filename == "":
        return jsonify({"error": "no_file"}), 400
    if not f.filename.lower().endswith(".mp4"):
        return jsonify({"error": "not_mp4"}), 400

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}.mp4"
    save_path = UPLOAD_DIR / name
    try:
        f.save(str(save_path))
    except Exception as e:
        return jsonify({"error": "save_failed", "detail": str(e)}), 500

    model_path = CKPT_DIR / "va_late_fusion_speech_emotion.joblib"
    if not model_path.exists():
        if save_path.exists():
            save_path.unlink()
        return jsonify({"error": "inference_failed", "detail": "Model checkpoint not found. Copy va_late_fusion_speech_emotion.joblib into checkpoints/ (see README)."}), 500

    try:
        from infer_va_from_mp4 import infer_va_from_video_path
        result = infer_va_from_video_path(save_path, model_path=model_path, use_tqdm=False)
    except Exception as e:
        if save_path.exists():
            save_path.unlink()
        return jsonify({"error": "inference_failed", "detail": str(e)}), 500

    timeline = {
        "times_gt": [],
        "valence_gt": [],
        "arousal_gt": [],
        "times_pred": result["times_sec"],
        "valence_pred": result["valence"],
        "arousal_pred": result["arousal"],
    }
    return jsonify({
        "timeline": timeline,
        "video_url": f"/uploads/{name}",
        "duration_sec": result["duration_sec"],
        "n_segments": result["n_segments"],
    })


def _stream_upload_gen(save_path, model_path, name):
    """Yield NDJSON lines: progress messages then result. Holds _inference_lock so only one inference runs at a time."""
    q = queue.Queue()

    def progress_cb(msg):
        q.put(("progress", msg))

    def run_inference():
        try:
            if MAX_VIDEO_DURATION_SEC > 0:
                from infer_va_from_mp4 import get_video_duration_fps
                duration_sec, _ = get_video_duration_fps(save_path)
                if duration_sec > MAX_VIDEO_DURATION_SEC:
                    if save_path.exists():
                        try:
                            save_path.unlink()
                        except OSError:
                            pass
                    q.put(("error", f"Video too long (max {MAX_VIDEO_DURATION_SEC}s). Yours: {duration_sec:.0f}s."))
                    return
            from infer_va_from_mp4 import infer_va_from_video_path
            result = infer_va_from_video_path(save_path, model_path=model_path, use_tqdm=False, progress_callback=progress_cb)
            timeline = {
                "times_gt": [], "valence_gt": [], "arousal_gt": [],
                "times_pred": result["times_sec"],
                "valence_pred": result["valence"],
                "arousal_pred": result["arousal"],
            }
            q.put(("result", {"timeline": timeline, "video_url": f"/uploads/{name}", "duration_sec": result["duration_sec"], "n_segments": result["n_segments"]}))
        except Exception as e:
            if save_path.exists():
                try:
                    save_path.unlink()
                except OSError:
                    pass
            q.put(("error", str(e)))

    with _inference_lock:
        t = threading.Thread(target=run_inference)
        t.start()
        while True:
            try:
                kind, payload = q.get(timeout=0.5)
            except queue.Empty:
                yield ""
                continue
            if kind == "progress":
                yield json.dumps({"type": "progress", "message": payload}) + "\n"
            elif kind == "result":
                yield json.dumps({"type": "result", **payload}) + "\n"
                break
            else:
                yield json.dumps({"type": "error", "detail": payload}) + "\n"
                break
        t.join(timeout=1)


@app.route("/api/upload-stream", methods=["POST", "OPTIONS"])
def api_upload_stream():
    """Streaming upload: returns NDJSON with progress lines then result."""
    if request.method == "OPTIONS":
        return "", 204
    if "video" not in request.files and "file" not in request.files:
        return jsonify({"error": "no_file"}), 400
    f = request.files.get("video") or request.files.get("file")
    if not f or f.filename == "":
        return jsonify({"error": "no_file"}), 400
    if not f.filename.lower().endswith(".mp4"):
        return jsonify({"error": "not_mp4"}), 400

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}.mp4"
    save_path = UPLOAD_DIR / name
    try:
        f.save(str(save_path))
    except Exception as e:
        return jsonify({"error": "save_failed", "detail": str(e)}), 500

    model_path = CKPT_DIR / "va_late_fusion_speech_emotion.joblib"
    if not model_path.exists():
        if save_path.exists():
            save_path.unlink()
        return jsonify({"error": "inference_failed", "detail": "Model checkpoint not found."}), 500

    return Response(
        _stream_upload_gen(save_path, model_path, name),
        mimetype="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    # attachment so "Download clip" triggers download instead of opening in player (cross-origin)
    return send_from_directory(
        UPLOAD_DIR, filename, mimetype="video/mp4",
        as_attachment=True, download_name=filename if filename.endswith(".mp4") else f"{filename}.mp4"
    )


if __name__ == "__main__":
    import os
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
