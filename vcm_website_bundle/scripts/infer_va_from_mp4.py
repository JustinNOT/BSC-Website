"""
Pipeline: MP4 -> extract features (same as training) -> KNN_V_k20_A_k5 -> continuous V/A.

Usage:
  python scripts/infer_va_from_mp4.py path/to/video.mp4
  python scripts/infer_va_from_mp4.py path/to/video.mp4 --out output.pt
  python scripts/infer_va_from_mp4.py path/to/video.mp4 --out output.json

Output: continuous valence/arousal per segment (segment center times in seconds).
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import torch
from tqdm import tqdm

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from extract_continuous_features import load_window_frames, build_feature_extractor
from run_va_sklearn_models import KNN_V_k20_A_k5

CKPT_DIR = ROOT / "checkpoints"
SEGMENT_LEN = 64
SEGMENT_HOP = 1   # one prediction per second (overlapping 64s windows)
# One 512-d feature per time step; we sample video at 1 Hz (one step per second)
TIME_STEP_SEC = 1.0


def get_video_duration_fps(video_path):
    """Return (duration_sec, fps)."""
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")
    frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    fps = cap.get(cv2.CAP_PROP_FPS)
    cap.release()
    if fps <= 0 or frame_count <= 0:
        raise RuntimeError(f"Invalid video (fps={fps}, frames={frame_count})")
    duration = frame_count / fps
    return duration, fps


def infer_va_from_video_path(video_path, model_path=None, use_tqdm=True, progress_callback=None):
    """
    Run MP4 -> features -> KNN_V_k20_A_k5. Returns dict with times_sec, valence, arousal, duration_sec.
    Callable from Flask or other code. video_path can be str or Path.
    If progress_callback(message: str) is given, it is called with status messages during inference.
    """
    import joblib
    def report(msg):
        if progress_callback:
            progress_callback(msg)

    video_path = Path(video_path)
    if not video_path.is_file():
        raise FileNotFoundError(f"Video not found: {video_path}")
    report("Loading video…")
    if model_path is None:
        late_fusion_path = CKPT_DIR / "va_late_fusion_speech_emotion.joblib"
        bias_path = CKPT_DIR / "va_sklearn_KNN_V_k20_A_k5_bias_corrected.joblib"
        if late_fusion_path.exists():
            model_path = late_fusion_path
        elif bias_path.exists():
            model_path = bias_path
        else:
            model_path = CKPT_DIR / "va_sklearn_KNN_V_k20_A_k5.joblib"
    model_path = Path(model_path)
    if not model_path.exists():
        raise FileNotFoundError(f"Model not found: {model_path}")

    duration, fps = get_video_duration_fps(video_path)
    n_actual_steps = max(1, int(duration / TIME_STEP_SEC))
    report("Building feature extractor…")
    times_sec = np.arange(0.0, duration, TIME_STEP_SEC)
    short_video = len(times_sec) < SEGMENT_LEN
    if short_video:
        # Extract one feature per second; we'll build padded segments per second below
        iter_times = times_sec
    else:
        # Pad to at least SEGMENT_LEN for sliding window
        if len(times_sec) < SEGMENT_LEN:
            extra = np.full(SEGMENT_LEN - len(times_sec), times_sec[-1] if len(times_sec) else 0.0)
            times_sec = np.concatenate([times_sec, extra])
        iter_times = times_sec

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    extractor = build_feature_extractor(device)
    n_steps = len(iter_times)
    _iter = tqdm(iter_times, desc="Extract features", leave=False) if use_tqdm else iter_times
    features_list = []
    for idx, t in enumerate(_iter):
        if progress_callback and n_steps > 0 and (idx % max(1, n_steps // 10) == 0 or idx == n_steps - 1):
            progress_callback(f"Extracting features… {idx + 1}/{n_steps}")
        frames = load_window_frames(str(video_path), float(t), fps)
        if frames is None:
            if features_list:
                features_list.append(features_list[-1].copy())
            continue
        frames = frames.unsqueeze(0).to(device)
        B, T, C, H, W = frames.shape
        frames = frames.view(B * T, C, H, W)
        with torch.no_grad():
            feats = extractor(frames)
        feats = feats.view(B, T, -1).mean(dim=1).cpu().numpy().squeeze()
        features_list.append(feats)
    n_actual = len(features_list)
    if n_actual < 1:
        raise RuntimeError("No features extracted from video")
    report("Aggregating features…")
    features = np.stack(features_list, axis=0).astype(np.float64)

    if short_video:
        # One prediction per second: build a 64-step padded segment for each second
        X_list = []
        times_out = []
        half = SEGMENT_LEN // 2  # 32 steps before center, 31 after (center at index 31)
        for i in range(n_actual):
            start_idx = max(0, i - half)
            end_idx = min(n_actual, i + half + 1)
            chunk = features[start_idx:end_idx]
            left_pad = max(0, half - i)
            right_pad = SEGMENT_LEN - left_pad - len(chunk)
            right_pad = max(0, right_pad)
            parts = []
            if left_pad:
                parts.append(np.tile(features[0:1], (left_pad, 1)))
            parts.append(chunk)
            if right_pad:
                parts.append(np.tile(features[-1:], (right_pad, 1)))
            seg = np.concatenate(parts, axis=0)[:SEGMENT_LEN]
            if len(seg) < SEGMENT_LEN:
                seg = np.concatenate([seg, np.tile(features[-1:], (SEGMENT_LEN - len(seg), 1))], axis=0)
            X_list.append(seg.mean(axis=0))
            times_out.append(i + 0.5)
        X = np.array(X_list)
        times_out = np.array(times_out, dtype=np.float64)
    else:
        n = len(features)
        X_list = []
        segment_starts = []
        for start in range(0, n - SEGMENT_LEN + 1, SEGMENT_HOP):
            end = start + SEGMENT_LEN
            X_list.append(features[start:end].mean(axis=0))
            segment_starts.append(start)
        X = np.array(X_list)
        segment_center_step = np.array(segment_starts, dtype=np.float64) + (SEGMENT_LEN - 1) / 2.0
        times_out = segment_center_step * TIME_STEP_SEC

    report("Loading model…")
    setattr(sys.modules.get("__main__", sys.modules[__name__]), "KNN_V_k20_A_k5", KNN_V_k20_A_k5)
    loaded = joblib.load(model_path)
    report("Predicting valence/arousal…")
    pred = None
    valence = None
    arousal = None
    if isinstance(loaded, dict) and "model_vis" in loaded:
        # Late fusion / va_best_fused: visual branch only (no audio in this pipeline)
        model_vis = loaded["model_vis"]
        bias_V = loaded.get("bias_V", 0.0)
        bias_A_vis = loaded.get("bias_A_visual_only", loaded.get("bias_A", 0.0))
        pred = model_vis.predict(X)
        pred = np.asarray(pred, dtype=np.float64)
        if pred.ndim == 1:
            pred = pred.reshape(-1, 2)
        valence = pred[:, 0] + float(bias_V)
        arousal = pred[:, 1] + float(bias_A_vis)
        if "scale_V_vis" in loaded and "shift_V_vis" in loaded:
            valence = valence * float(loaded["scale_V_vis"]) + float(loaded["shift_V_vis"])
        if "scale_A_vis" in loaded and "shift_A_vis" in loaded:
            arousal = arousal * float(loaded["scale_A_vis"]) + float(loaded["shift_A_vis"])
        valence = np.asarray(valence, dtype=np.float64)
        arousal = np.asarray(arousal, dtype=np.float64)
    elif isinstance(loaded, dict) and "model" in loaded:
        model = loaded["model"]
        bias_V = loaded.get("bias_V", 0.0)
        bias_A = loaded.get("bias_A", 0.0)
        pred = model.predict(X)
        pred = np.asarray(pred, dtype=np.float64)
        if pred.ndim == 1:
            pred = pred.reshape(-1, 2)
        valence = pred[:, 0] + float(bias_V)
        arousal = pred[:, 1] + float(bias_A)
    else:
        model = loaded
        pred = np.asarray(model.predict(X), dtype=np.float64)
        if pred.ndim == 1:
            pred = pred.reshape(-1, 2)
        valence = pred[:, 0]
        arousal = pred[:, 1]
    if valence is None or arousal is None:
        raise RuntimeError("Model prediction produced no valence/arousal")
    return {
        "times_sec": times_out.tolist(),
        "valence": valence.tolist(),
        "arousal": arousal.tolist(),
        "duration_sec": float(duration),
        "n_segments": len(times_out),
    }


def main():
    parser = argparse.ArgumentParser(description="MP4 -> features -> KNN_V_k20_A_k5 -> V/A")
    parser.add_argument("video", type=str, help="Path to .mp4 file")
    parser.add_argument("--out", type=str, default=None, help="Output path (.pt or .json); default: print only")
    parser.add_argument("--model", type=str, default=None, help="Model filename in checkpoints/ (default: bias-corrected if present else KNN_V_k20_A_k5)")
    parser.add_argument("--fps", type=float, default=None, help="Override FPS (default: read from video)")
    args = parser.parse_args()

    video_path = Path(args.video)
    model_path = CKPT_DIR / args.model if args.model else None
    try:
        out_data = infer_va_from_video_path(video_path, model_path=model_path, use_tqdm=True)
    except Exception as e:
        print(f"Error: {e}")
        return 1
    times_out = np.array(out_data["times_sec"])
    valence = np.array(out_data["valence"])
    arousal = np.array(out_data["arousal"])
    duration = out_data["duration_sec"]

    print(f"Video: {video_path.name}  duration={duration:.1f}s")
    print(f"Segments: {len(times_out)}  ->  continuous V/A from {times_out[0]:.1f}s to {times_out[-1]:.1f}s")
    print()
    print("time_s   valence   arousal")
    print("------   ------    ------")
    for i in range(min(10, len(times_out))):
        print(f"  {times_out[i]:5.1f}   {valence[i]:.4f}   {arousal[i]:.4f}")
    if len(times_out) > 10:
        print("  ...")
        print(f"  {times_out[-1]:5.1f}   {valence[-1]:.4f}   {arousal[-1]:.4f}")

    out_data["video"] = str(video_path)

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        if out_path.suffix.lower() == ".json":
            with open(out_path, "w") as f:
                json.dump(out_data, f, indent=2)
            print(f"\nSaved JSON to {out_path}")
        else:
            torch.save(out_data, out_path)
            print(f"\nSaved to {out_path}")
    else:
        print("\n(Use --out output.pt or --out output.json to save)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
