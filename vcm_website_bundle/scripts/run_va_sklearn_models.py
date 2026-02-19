"""
Train/save the 3 sklearn V/A models used in the 6-model comparison (seed 999).
Same segment data as DL pipeline. Run compare_va_checkpoints.py for full table.

Usage:
  python scripts/run_va_sklearn_models.py --only KNN_k5
  python scripts/run_va_sklearn_models.py --only KNN_k20_distance
  python scripts/run_va_sklearn_models.py --only KNN_V_k20_A_k5
  python scripts/run_va_sklearn_models.py   # train all 3, print comparison
"""
import argparse
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
FEATURES_DIR = ROOT / "data" / "continuous_features"
RESULTS_DIR = ROOT / "results"
SEGMENT_LEN = 64
SEGMENT_HOP = 32
TRAIN_RATIO = 0.7
VAL_RATIO = 0.15
BEST_AVG_CORR = 0.3220  # KNN_V_k20_A_k5 (no pretrained)


def get_movie_split(features_dir, train_ratio, val_ratio, seed):
    import random
    paths = list(Path(features_dir).glob("*.pt"))
    ids = sorted([p.stem.replace("_", " ") for p in paths])
    random.seed(seed)
    random.shuffle(ids)
    n_train = int(len(ids) * train_ratio)
    n_val = int(len(ids) * val_ratio)
    return ids[:n_train], ids[n_train : n_train + n_val], ids[n_train + n_val :]


def load_segment_data(movie_ids, features_dir):
    """Return (X, y) where X is (n_segments, 512), y is (n_segments, 2)."""
    X_list, y_list = [], []
    for mid in movie_ids:
        path = Path(features_dir) / f"{mid.replace(' ', '_')}.pt"
        if not path.exists():
            continue
        try:
            d = torch.load(path, map_location="cpu", weights_only=False)
        except TypeError:
            d = torch.load(path, map_location="cpu")
        feats = np.asarray(d["features"], dtype=np.float64)
        val = np.asarray(d["valence"], dtype=np.float64)
        aro = np.asarray(d["arousal"], dtype=np.float64)
        n = len(feats)
        if n < SEGMENT_LEN:
            continue
        for start in range(0, n - SEGMENT_LEN + 1, SEGMENT_HOP):
            end = start + SEGMENT_LEN
            X_list.append(feats[start:end].mean(axis=0))
            y_list.append([val[start:end].mean(), aro[start:end].mean()])
    return np.array(X_list), np.array(y_list)


CKPT_DIR = ROOT / "checkpoints"


def safe_corr(a, b):
    a, b = np.asarray(a).ravel(), np.asarray(b).ravel()
    if len(a) < 2:
        return 0.0
    return np.corrcoef(a, b)[0, 1] if np.std(a) > 1e-12 and np.std(b) > 1e-12 else 0.0


def compute_r2(y_true, y_pred):
    ss_tot = np.sum((y_true - y_true.mean()) ** 2) + 1e-12
    ss_res = np.sum((y_true - y_pred) ** 2)
    return 1.0 - (ss_res / ss_tot)


class KNN_V_k20_A_k5:
    """Valence from KNN k=20 distance (better Corr V), Arousal from KNN k=5 (keep Corr A)."""
    def __init__(self):
        from sklearn.neighbors import KNeighborsRegressor
        self.v_model = KNeighborsRegressor(n_neighbors=20, weights="distance")
        self.a_model = KNeighborsRegressor(n_neighbors=5)

    def fit(self, X, y):
        self.v_model.fit(X, y[:, 0])
        self.a_model.fit(X, y[:, 1])
        return self

    def predict(self, X):
        return np.column_stack([self.v_model.predict(X), self.a_model.predict(X)])


def build_models():
    """The 3 sklearn models in the 6-model comparison (KNN_k5, KNN_k20_distance, KNN_V_k20_A_k5)."""
    from sklearn.neighbors import KNeighborsRegressor
    from sklearn.multioutput import MultiOutputRegressor
    return [
        ("KNN_k5", MultiOutputRegressor(KNeighborsRegressor(n_neighbors=5))),
        ("KNN_k20_distance", MultiOutputRegressor(KNeighborsRegressor(n_neighbors=20, weights="distance"))),
        ("KNN_V_k20_A_k5", KNN_V_k20_A_k5()),
    ]


def main():
    parser = argparse.ArgumentParser(description="Train the 3 sklearn V/A models (KNN_k5, KNN_k20_distance, KNN_V_k20_A_k5)")
    parser.add_argument("--seed", type=int, default=999, help="Split seed (default 999)")
    parser.add_argument("--only", type=str, default=None, help="Train only this model and save to checkpoints/")
    args = parser.parse_args()

    train_ids, val_ids, test_ids = get_movie_split(FEATURES_DIR, TRAIN_RATIO, VAL_RATIO, args.seed)
    X_train, y_train = load_segment_data(train_ids, FEATURES_DIR)
    X_val, y_val = load_segment_data(val_ids, FEATURES_DIR)
    X_test, y_test = load_segment_data(test_ids, FEATURES_DIR)
    X_tr = np.vstack([X_train, X_val])
    y_tr = np.vstack([y_train, y_val])

    if args.only:
        models = [(name, m) for name, m in build_models() if name == args.only]
        if not models:
            print(f"Unknown model: {args.only}. Use: KNN_k5, KNN_k20_distance, KNN_V_k20_A_k5")
            return
        name, model = models[0]
        model.fit(X_tr, y_tr)
        pred = model.predict(X_test)
        mse = float(np.mean((pred - y_test) ** 2))
        mse_v = float(np.mean((pred[:, 0] - y_test[:, 0]) ** 2))
        mse_a = float(np.mean((pred[:, 1] - y_test[:, 1]) ** 2))
        corr_v = safe_corr(pred[:, 0], y_test[:, 0])
        corr_a = safe_corr(pred[:, 1], y_test[:, 1])
        avg_corr = (corr_v + corr_a) / 2
        r2_v = compute_r2(y_test[:, 0], pred[:, 0])
        r2_a = compute_r2(y_test[:, 1], pred[:, 1])
        avg_r2 = (r2_v + r2_a) / 2
        CKPT_DIR.mkdir(parents=True, exist_ok=True)
        save_path = CKPT_DIR / f"va_sklearn_{name}.joblib"
        import joblib
        joblib.dump(model, save_path)
        print(f"Test segments: {len(X_test)} (seed {args.seed})")
        print()
        print(f"--- {name} ---")
        print(f"  MSE:      {mse:.4f}   (V: {mse_v:.4f}   A: {mse_a:.4f})")
        print(f"  Corr V:   {corr_v:.4f}   Corr A:   {corr_a:.4f}   Avg Corr: {avg_corr:.4f}")
        print(f"  R2 V:     {r2_v:.4f}   R2 A:     {r2_a:.4f}   Avg R2:   {avg_r2:.4f}")
        print()
        print(f"Saved to {save_path}")
        print("Done.")
        return

    print(f"Train+Val: {X_tr.shape[0]} segments | Test: {X_test.shape[0]} (seed {args.seed})")
    print(f"Best (KNN_V_k20_A_k5): Avg Corr = {BEST_AVG_CORR:.4f}")
    print()

    models = build_models()
    results = []
    for name, model in models:
        try:
            model.fit(X_tr, y_tr)
            pred = model.predict(X_test)
            mse = float(np.mean((pred - y_test) ** 2))
            corr_v = safe_corr(pred[:, 0], y_test[:, 0])
            corr_a = safe_corr(pred[:, 1], y_test[:, 1])
            avg_corr = (corr_v + corr_a) / 2
            results.append((name, mse, corr_v, corr_a, avg_corr))
        except Exception as e:
            print(f"  {name}: failed ({e})")
            continue

    # Readable output
    print("--- Model results (MSE, Corr V, Corr A, Avg Corr) ---")
    for name, mse, corr_v, corr_a, avg_corr in results:
        beat = "  *** best ***" if avg_corr >= BEST_AVG_CORR else ""
        print(f"  {name}: MSE={mse:.4f}  Corr_V={corr_v:.4f}  Corr_A={corr_a:.4f}  Avg_Corr={avg_corr:.4f}{beat}")
    print()

    best = max(results, key=lambda x: x[4])
    print(f"Best: {best[0]} (Avg Corr {best[4]:.4f})")

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out = ROOT / "results" / "va_sklearn_models_comparison.txt"
    with open(out, "w") as f:
        f.write(f"Sklearn models (seed {args.seed}). Best: KNN_V_k20_A_k5 Avg Corr = {BEST_AVG_CORR:.4f}\n\n")
        for name, mse, corr_v, corr_a, avg_corr in results:
            f.write(f"{name}: MSE={mse:.4f} Corr_V={corr_v:.4f} Corr_A={corr_a:.4f} Avg_Corr={avg_corr:.4f}\n")
        f.write(f"\nBest: {best[0]} (Avg Corr {best[4]:.4f})\n")
    print(f"\nWritten to {out}")
    print("Done.")


if __name__ == "__main__":
    main()
