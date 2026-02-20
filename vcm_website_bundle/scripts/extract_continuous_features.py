"""
Extract ResNet18 features from raw LIRIS-ACCEDE continuous videos.

Reads raw annotations (valence/arousal time series per movie), loads each movie,
extracts frames at each annotation timestamp, runs ResNet18 backbone, saves
(timestamp, 512-dim features, valence, arousal) per movie.

Output: data/continuous_features/{movie_id}.pt
    Each file: dict with keys "times", "features", "valence", "arousal"
"""
import os
import sys
import re
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.nn as nn
import torchvision.models as models
from tqdm import tqdm

ROOT = Path(__file__).resolve().parents[1]
ANNOT_ROOT = ROOT / "data" / "liris_continuous" / "annotations" / "continuous-annotations"
MOVIE_ROOT = ROOT / "data" / "liris_continuous" / "movies"
OUT_DIR = ROOT / "data" / "continuous_features"

# Feature extraction config
NUM_FRAMES = 16      # frames per window
IMG_SIZE = 112       # resize frames
WINDOW_SEC = 2.0     # half-window: grab frames in [t - WINDOW_SEC/2, t + WINDOW_SEC/2]


def norm_key(s: str) -> str:
    return "".join(c for c in s.lower() if c.isalnum())


def find_annotation_pairs():
    """Find (movie_id, valence_path, arousal_path) pairs."""
    if not ANNOT_ROOT.exists():
        raise FileNotFoundError(f"Annotations not found: {ANNOT_ROOT}")
    val_files = [f for f in ANNOT_ROOT.iterdir() if f.is_file() and f.suffix.lower() == ".txt" and "valence" in f.stem.lower()]
    pairs = []
    for vf in sorted(val_files):
        movie_id = re.sub(r"_valence$", "", vf.stem, flags=re.I)
        aro = ANNOT_ROOT / f"{movie_id}_Arousal.txt"
        if not aro.exists():
            aro = ANNOT_ROOT / f"{movie_id}_arousal.txt"
        if aro.exists():
            pairs.append((movie_id, str(vf), str(aro)))
    return pairs


def load_time_series(path):
    """Load (times, values) from annotation file. Returns (np.ndarray, np.ndarray)."""
    times, vals = [], []
    with open(path, "r") as f:
        for line in f:
            line = line.strip().replace(";", ",").replace("\t", ",")
            parts = [p.strip() for p in line.split(",") if p.strip()]
            if len(parts) >= 2:
                try:
                    t, v = float(parts[0]), float(parts[1])
                    times.append(t)
                    vals.append(v)
                except ValueError:
                    continue
            elif len(parts) == 1:
                try:
                    v = float(parts[0])
                    t = float(len(times))
                    times.append(t)
                    vals.append(v)
                except ValueError:
                    continue
    if not times:
        raise RuntimeError(f"No data parsed from {path}")
    return np.array(times), np.array(vals)


def find_movie_path(movie_id):
    """Find .mp4 file matching movie_id under MOVIE_ROOT."""
    key = norm_key(movie_id)
    for root, _, files in os.walk(MOVIE_ROOT):
        for f in files:
            if f.lower().endswith(".mp4"):
                fk = norm_key(Path(f).stem)
                if key in fk or fk in key:
                    return os.path.join(root, f)
    return None


def _normalize_frames_np(frames_np):
    """Apply ImageNet norm to (N, 3, H, W) float32."""
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(1, 3, 1, 1)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(1, 3, 1, 1)
    return (frames_np - mean) / std


def load_window_frames(video_path, t_sec, fps, num_frames=NUM_FRAMES, img_size=IMG_SIZE, cap=None):
    """
    Load num_frames around t_sec. Returns (N, 3, H, W) float32 normalized.
    If cap is provided (cv2.VideoCapture), it is used and not released (caller must release).
    """
    own_cap = False
    if cap is None:
        cap = cv2.VideoCapture(video_path)
        own_cap = True
    if not cap.isOpened():
        if own_cap:
            cap.release()
        return None
    frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    if fps <= 0 or frame_count <= 0:
        if own_cap:
            cap.release()
        return None

    duration = frame_count / fps
    t_start = max(0.0, t_sec - WINDOW_SEC / 2)
    t_end = min(duration, t_sec + WINDOW_SEC / 2)
    if t_end <= t_start:
        t_end = min(duration, t_start + 0.5)

    times = np.linspace(t_start, t_end, num_frames, endpoint=True)
    frames = []
    for t in times:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            if frames:
                frames.append(frames[-1].copy())
            continue
        frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        frame = cv2.resize(frame, (img_size, img_size), interpolation=cv2.INTER_AREA)
        frame = frame.astype(np.float32) / 255.0
        frames.append(frame)
    if own_cap:
        cap.release()

    if len(frames) < num_frames:
        while len(frames) < num_frames and frames:
            frames.append(frames[-1].copy())
    if len(frames) == 0:
        return None

    frames = np.stack(frames[:num_frames], axis=0)  # (N, H, W, 3)
    frames = np.transpose(frames, (0, 3, 1, 2))     # (N, 3, H, W)
    frames = _normalize_frames_np(frames)
    return torch.from_numpy(frames).float()


def load_all_windows_sequential(video_path, times_sec, fps, num_frames=NUM_FRAMES, img_size=IMG_SIZE,
                                progress_callback=None):
    """
    Load all windows in one sequential pass (no seeking). Much faster for long videos.
    times_sec: array of center times for each window.
    Returns (n_windows, num_frames, 3, img_size, img_size) tensor, or None on failure.
    """
    video_path = str(video_path)
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return None
    frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    if fps <= 0 or frame_count <= 0:
        cap.release()
        return None
    duration = frame_count / fps
    n_steps = len(times_sec)

    # For each window w, 16 target times; need[frame_idx] = [(w, s), ...]
    need = defaultdict(list)
    for w, t_sec in enumerate(times_sec):
        t_start = max(0.0, t_sec - WINDOW_SEC / 2)
        t_end = min(duration, t_sec + WINDOW_SEC / 2)
        if t_end <= t_start:
            t_end = min(duration, t_start + 0.5)
        slot_times = np.linspace(t_start, t_end, num_frames, endpoint=True)
        for s, t in enumerate(slot_times):
            frame_idx = int(round(t * fps))
            frame_idx = max(0, min(frame_idx, int(frame_count) - 1))
            need[frame_idx].append((w, s))

    # Preallocate: frames per (w, s) as (H, W, 3) float [0,1]
    windows = [[None] * num_frames for _ in range(n_steps)]
    total_frames = int(frame_count)
    last_frame = None
    report_interval = max(1, total_frames // 20)

    for frame_idx in range(total_frames):
        if progress_callback and frame_idx > 0 and frame_idx % report_interval == 0:
            progress_callback(f"Reading video… {frame_idx}/{total_frames}")
        ok, frame = cap.read()
        if not ok:
            break
        if frame_idx not in need:
            continue
        frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        frame = cv2.resize(frame, (img_size, img_size), interpolation=cv2.INTER_AREA)
        frame = frame.astype(np.float32) / 255.0
        last_frame = frame
        for (w, s) in need[frame_idx]:
            windows[w][s] = frame.copy()
    cap.release()

    # Fill missing slots (boundaries) with last or first frame
    for w in range(n_steps):
        for s in range(num_frames):
            if windows[w][s] is None:
                windows[w][s] = last_frame if last_frame is not None else np.zeros((img_size, img_size, 3), dtype=np.float32)

    # Stack: (n_steps, num_frames, H, W, 3) -> (n_steps, num_frames, 3, H, W), normalize
    arr = np.stack([[windows[w][s] for s in range(num_frames)] for w in range(n_steps)], axis=0)
    arr = np.transpose(arr, (0, 1, 4, 2, 3))  # (n_steps, 16, 3, H, W)
    arr = _normalize_frames_np(arr)  # broadcasts over first dim
    return torch.from_numpy(arr).float()


def build_feature_extractor(device):
    """ResNet18 backbone (no FC). Output: 512-dim per frame."""
    base = models.resnet18(weights=models.ResNet18_Weights.IMAGENET1K_V1)
    backbone = nn.Sequential(*list(base.children())[:-1])
    backbone.eval()
    return backbone.to(device)


def extract_features_for_movie(movie_id, val_path, aro_path, extractor, device):
    """
    Load valence/arousal time series, find video, extract features at each timestamp.
    Returns dict: times, features (N, 512), valence, arousal.
    """
    t_val, v_val = load_time_series(val_path)
    t_aro, v_aro = load_time_series(aro_path)

    # align to common timestamps (intersection or interpolation)
    n = min(len(t_val), len(t_aro))
    t_val, v_val = t_val[:n], v_val[:n]
    t_aro, v_aro = t_aro[:n], v_aro[:n]

    if not np.allclose(t_val, t_aro):
        t_common = np.linspace(max(t_val[0], t_aro[0]), min(t_val[-1], t_aro[-1]), n)
        v_val = np.interp(t_common, t_val, v_val)
        v_aro = np.interp(t_common, t_aro, v_aro)
        times = t_common
    else:
        times = t_val

    video_path = find_movie_path(movie_id)
    if not video_path or not os.path.isfile(video_path):
        print(f"  [SKIP] No video found for {movie_id}")
        return None

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    cap.release()

    if fps <= 0:
        print(f"  [SKIP] Invalid FPS for {movie_id}")
        return None

    features_list = []
    valid_times = []
    valid_val = []
    valid_aro = []

    extractor.eval()
    with torch.no_grad():
        for i, (t, vv, va) in enumerate(tqdm(
            zip(times, v_val, v_aro),
            total=len(times),
            desc=movie_id,
            ncols=80,
        )):
            frames = load_window_frames(video_path, float(t), fps)
            if frames is None:
                continue
            frames = frames.unsqueeze(0).to(device)  # (1, N, 3, H, W)
            B, T, C, H, W = frames.shape
            frames = frames.view(B * T, C, H, W)
            feats = extractor(frames)  # (B*T, 512, 1, 1)
            feats = feats.view(B, T, -1).mean(dim=1)  # (1, 512)
            features_list.append(feats.cpu().numpy().squeeze())
            valid_times.append(t)
            valid_val.append(vv)
            valid_aro.append(va)

    if not features_list:
        print(f"  [SKIP] No features extracted for {movie_id}")
        return None

    return {
        "times": np.array(valid_times),
        "features": np.stack(features_list, axis=0).astype(np.float32),
        "valence": np.array(valid_val, dtype=np.float32),
        "arousal": np.array(valid_aro, dtype=np.float32),
        "movie_id": movie_id,
    }


def main():
    print("Extract ResNet18 features from LIRIS-ACCEDE continuous videos")
    print(f"Annotations: {ANNOT_ROOT}")
    print(f"Movies:      {MOVIE_ROOT}")
    print(f"Output:      {OUT_DIR}")
    print()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")

    pairs = find_annotation_pairs()
    if not pairs:
        print("No annotation pairs found.")
        return
    print(f"Found {len(pairs)} movie annotation pairs\n")

    extractor = build_feature_extractor(device)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for movie_id, val_path, aro_path in pairs:
        result = extract_features_for_movie(movie_id, val_path, aro_path, extractor, device)
        if result is not None:
            out_path = OUT_DIR / f"{movie_id.replace(' ', '_')}.pt"
            torch.save(result, out_path)
            print(f"  Saved {result['features'].shape[0]} samples -> {out_path}")

    print("\nDone.")


if __name__ == "__main__":
    main()
