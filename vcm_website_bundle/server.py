"""
Standalone Flask API for V/A model: POST /api/upload (MP4 -> timeline), GET /uploads/<name>.
Run from this bundle folder (no dependency on Git-LA). All code and checkpoint live inside this folder.

  pip install -r requirements.txt
  python server.py

Crashes are often due to: (1) Out-of-memory on long or high-res videos, (2) only one inference
at a time is safe on small instances, (3) disk full from many uploads.
"""
import os
import subprocess
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

from flask import Flask, jsonify, request, send_from_directory, send_file, Response

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 500 * 1024 * 1024  # 500 MB

UPLOAD_DIR = BUNDLE_ROOT / "uploads"
CKPT_DIR = BUNDLE_ROOT / "checkpoints"

# Only one inference at a time to avoid OOM (PyTorch + frames are memory-heavy)
_inference_lock = threading.Lock()
# Max video duration in seconds (avoids OOM on very long videos). Set VA_MAX_DURATION_SEC=0 to disable.
MAX_VIDEO_DURATION_SEC = int(os.environ.get("VA_MAX_DURATION_SEC", "600"))  # default 10 min
# Reject oversized uploads early (e.g. mobile can send huge files and cause OOM). Set VA_MAX_UPLOAD_MB=0 to use only MAX_CONTENT_LENGTH.
MAX_UPLOAD_MB = int(os.environ.get("VA_MAX_UPLOAD_MB", "200"))


def _reject_if_too_large():
    """Return (response, status) if Content-Length exceeds MAX_UPLOAD_MB; else (None, None)."""
    if MAX_UPLOAD_MB <= 0:
        return None, None
    cl = request.content_length
    if cl is not None and cl > MAX_UPLOAD_MB * 1024 * 1024:
        return jsonify({"error": "file_too_large", "detail": f"Video must be under {MAX_UPLOAD_MB} MB. Use a shorter clip or compress it."}), 413
    return None, None


VA_TRANSCODE_FOR_BROWSER = os.environ.get("VA_TRANSCODE_FOR_BROWSER", "1").lower() in ("1", "true", "yes")


def _get_ffmpeg_path() -> str:
    """Use imageio-ffmpeg's bundled ffmpeg so we don't rely on system install."""
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


def _transcode_to_h264(src: Path, dest: Path) -> bool:
    """Transcode video to H.264 MP4 for browser playback (fixes black screen with HEVC/ProRes). Returns True on success."""
    ffmpeg_exe = _get_ffmpeg_path()
    cmds = [
        [ffmpeg_exe, "-y", "-i", str(src),
         "-c:v", "libx264", "-preset", "fast", "-crf", "23",
         "-c:a", "aac", "-b:a", "128k",
         "-movflags", "+faststart",
         str(dest)],
        [ffmpeg_exe, "-y", "-i", str(src),
         "-c:v", "libx264", "-preset", "fast", "-crf", "23",
         "-an", "-movflags", "+faststart",
         str(dest)],
    ]
    for args in cmds:
        try:
            r = subprocess.run(args, capture_output=True, timeout=600)
            if r.returncode == 0 and dest.is_file():
                return True
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            print(f"[VA] Transcode warning: {e}", flush=True)
            return False
    print("[VA] Transcode failed (tried with and without audio)", flush=True)
    return False


def _ensure_browser_playable(save_path: Path, name: str) -> str:
    """If transcoding is enabled, produce H.264 version for playback. Returns filename to serve."""
    if not VA_TRANSCODE_FOR_BROWSER:
        return name
    ext = (name or "").lower().split(".")[-1] if "." in name else ""
    play_name = (Path(name).stem or "video") + "_playback.mp4"
    play_path = save_path.parent / play_name
    if _transcode_to_h264(save_path, play_path):
        return play_name
    return name


def _allowed_ext_and_name(f):
    """Return (ext, name) for saved file. Accepts .mp4/.mov by extension or by content-type (e.g. mobile may send generic filename)."""
    filename = (f.filename or "").strip()
    ext = filename.lower().split(".")[-1] if "." in filename else ""
    if ext not in ("mp4", "mov"):
        # Some mobile clients send wrong or empty filename; check file content type
        ct = (f.content_type or "").lower()
        if "quicktime" in ct or "video/x-mov" in ct:
            ext = "mov"
        elif "mp4" in ct or "video/mp4" in ct:
            ext = "mp4"
    if ext not in ("mp4", "mov"):
        return None, None
    return ext, f"{uuid.uuid4().hex}.{ext}"


@app.after_request
def cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Range"
    response.headers["Access-Control-Expose-Headers"] = "Content-Length, Accept-Ranges, Content-Range"
    return response


@app.route("/api/upload", methods=["POST", "OPTIONS"])
def api_upload():
    if request.method == "OPTIONS":
        return "", 204
    resp, code = _reject_if_too_large()
    if resp is not None:
        return resp, code
    if "video" not in request.files and "file" not in request.files:
        return jsonify({"error": "no_file"}), 400
    f = request.files.get("video") or request.files.get("file")
    if not f:
        return jsonify({"error": "no_file"}), 400
    ext, name = _allowed_ext_and_name(f)
    if ext is None:
        return jsonify({"error": "not_video", "detail": "Please upload an MP4 or MOV file"}), 400

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
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

    play_name = _ensure_browser_playable(save_path, name)
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
        "video_url": f"/uploads/{play_name}",
        "duration_sec": result["duration_sec"],
        "n_segments": result["n_segments"],
        "mean_prediction_confidence": result.get("mean_prediction_confidence"),
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
            play_name = _ensure_browser_playable(save_path, name)
            timeline = {
                "times_gt": [], "valence_gt": [], "arousal_gt": [],
                "times_pred": result["times_sec"],
                "valence_pred": result["valence"],
                "arousal_pred": result["arousal"],
            }
            q.put(("result", {"timeline": timeline, "video_url": f"/uploads/{play_name}", "duration_sec": result["duration_sec"], "n_segments": result["n_segments"], "mean_prediction_confidence": result.get("mean_prediction_confidence")}))
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
    resp, code = _reject_if_too_large()
    if resp is not None:
        return resp, code
    if "video" not in request.files and "file" not in request.files:
        return jsonify({"error": "no_file"}), 400
    f = request.files.get("video") or request.files.get("file")
    if not f:
        return jsonify({"error": "no_file"}), 400
    ext, name = _allowed_ext_and_name(f)
    if ext is None:
        return jsonify({"error": "not_video", "detail": "Please upload an MP4 or MOV file"}), 400

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
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


@app.route("/uploads/<path:filename>", methods=["GET", "OPTIONS"])
def serve_upload(filename):
    """Serve video inline with Range request support for browser playback and seeking."""
    if request.method == "OPTIONS":
        return "", 204
    filepath = (UPLOAD_DIR / filename).resolve()
    try:
        filepath.relative_to(UPLOAD_DIR.resolve())
    except ValueError:
        return jsonify({"error": "not_found"}), 404
    if not filepath.is_file():
        return jsonify({"error": "not_found"}), 404
    mimetype = "video/quicktime" if (filename or "").lower().endswith(".mov") else "video/mp4"
    return send_file(
        filepath,
        mimetype=mimetype,
        as_attachment=False,
        download_name=filename,
        conditional=True,
    )


def _warmup_resnet():
    """Pre-download ResNet18 at startup so first inference doesn't trigger download during request."""
    try:
        import torch
        from extract_continuous_features import build_feature_extractor
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        build_feature_extractor(device)
        print("[VA] ResNet18 pre-loaded (warmup complete)", flush=True)
    except Exception as e:
        print(f"[VA] Warmup warning: {e}", flush=True)


# Pre-load ResNet18 at import so first request doesn't download during inference
_warmup_resnet()

if __name__ == "__main__":
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
