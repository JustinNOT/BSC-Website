# V/A Upload API Contract

Base URL: e.g. `http://localhost:5000` when running `server.py` from this bundle.

## POST /api/upload

- **Request**: `multipart/form-data` with one of:
  - `video`: MP4 file
  - `file`: MP4 file
- **Success (200)**:
```json
{
  "timeline": {
    "times_gt": [],
    "valence_gt": [],
    "arousal_gt": [],
    "times_pred": [0.5, 1.5, 2.5, ...],
    "valence_pred": [0.12, -0.05, ...],
    "arousal_pred": [0.3, 0.25, ...]
  },
  "video_url": "/uploads/<uuid>.mp4",
  "duration_sec": 120.5,
  "n_segments": 120
}
```
- **Errors**:
  - 400 `{ "error": "no_file" }` – no file in request
  - 400 `{ "error": "not_mp4" }` – file is not .mp4
  - 500 `{ "error": "save_failed", "detail": "..." }` – could not save file
  - 500 `{ "error": "inference_failed", "detail": "..." }` – model or feature extraction failed

## GET /uploads/<filename>

- Serves the uploaded MP4. Use with `video_url` from the upload response (same origin as API or full URL).
