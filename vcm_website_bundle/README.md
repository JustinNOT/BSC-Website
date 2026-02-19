# V/A Model Bundle for VCM Website

Self-contained folder to run the **valence/arousal (V/A) API** and frontend in **any repo** (e.g. your VCM website). No dependency on the Git-LA repo after you copy this folder and add the checkpoint.

## What’s in this folder

| Item | Description |
|------|-------------|
| `server.py` | Flask API: POST /api/upload (MP4 → V/A timeline), GET /uploads/<name> |
| `scripts/` | Inference: `infer_va_from_mp4.py`, `extract_continuous_features.py`, `run_va_sklearn_models.py` |
| `checkpoints/` | Put **va_late_fusion_speech_emotion.joblib** here (see step 1) |
| `uploads/` | Temporary uploaded videos (created automatically) |
| `frontend/` | `va-timeline.js`, `va-timeline.css`, `html-snippet.html` for your VCM site |
| `requirements.txt` | Python dependencies |
| `api-contract.md` | API request/response reference |

## Step 1: Add the model checkpoint (one-time)

The API needs the trained model file. **From the Git-LA repo root**, copy it into this bundle:

**PowerShell:**
```powershell
Copy-Item "checkpoints\va_late_fusion_speech_emotion.joblib" "vcm_website_bundle\checkpoints\"
```

**Cmd:**
```cmd
copy checkpoints\va_late_fusion_speech_emotion.joblib vcm_website_bundle\checkpoints\
```

Or run the helper script from Git-LA root:
```powershell
.\vcm_website_bundle\copy_checkpoint.ps1
```

After this, `vcm_website_bundle/checkpoints/va_late_fusion_speech_emotion.joblib` should exist.

## Step 2: Copy this folder to your other repo

Copy the entire **vcm_website_bundle** folder (including `checkpoints/va_late_fusion_speech_emotion.joblib`) into your VCM website repo wherever you want the backend to live (e.g. `backend/va-api/` or project root). Nothing in the bundle references Git-LA.

## Step 3: Run the API (in the other repo)

In the folder you copied (e.g. `backend/va-api/` or `vcm_website_bundle/`):

```bash
pip install -r requirements.txt
python server.py
```

Server runs at **http://localhost:5000**. It will use the checkpoint in `checkpoints/va_late_fusion_speech_emotion.joblib` inside this folder.

## Step 4: Frontend in your VCM site

In your VCM website repo:

1. Copy `frontend/va-timeline.js` and `frontend/va-timeline.css` to your static assets.
2. Add the HTML from `frontend/html-snippet.html` where you want the upload + V/A charts.
3. Include Chart.js and call `VATimeline.init({ apiBaseUrl: 'http://localhost:5000', ... })` (see `html-snippet.html` for full options).

Point `apiBaseUrl` at wherever you run `server.py` (same machine or your deployed API URL).

## Summary

1. **One-time:** Copy `va_late_fusion_speech_emotion.joblib` from Git-LA into `vcm_website_bundle/checkpoints/`.
2. Copy the whole **vcm_website_bundle** folder into your other repo.
3. In that repo: `pip install -r requirements.txt` and `python server.py`.
4. Use `frontend/` assets in your VCM site and set `apiBaseUrl` to your API.

No Git-LA dependency at runtime; the bundle has the model and all code.
