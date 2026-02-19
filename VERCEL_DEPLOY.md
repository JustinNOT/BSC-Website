# Vercel: make sure the live site uses this repo

The **frontend** lives in the `frontend/` folder. If the live site doesn’t show your latest changes (e.g. the “hi” footer), do this:

## 1. Use the repo’s build config

A **`vercel.json`** at the repo root is set up so Vercel builds the app from `frontend/` even when the project root is the repo root:

- **Install:** `cd frontend && npm install`
- **Build:** `cd frontend && npm run build`
- **Output:** `frontend/dist`

Commit and push `vercel.json` if you haven’t already. Then trigger a new deploy (see step 3).

## 2. Check Vercel project settings

In **Vercel** → your project → **Settings** → **General**:

| Setting | Should be |
|--------|------------|
| **Root Directory** | Leave **empty** (repo root). The `vercel.json` above runs commands inside `frontend/`. |
| **Build Command** | Can be empty (Vercel will use `vercel.json`’s `buildCommand`). |
| **Output Directory** | Can be empty (Vercel will use `vercel.json`’s `outputDirectory`). |

If you had **Root Directory** = `frontend` before, clear it so the root is the repo. Then the root `vercel.json` is used and the build will still run in `frontend/` via the commands in that file.

## 3. Redeploy after push

- Push your latest code (including `vercel.json` and the “hi” footer) to the branch Vercel uses (e.g. `main`).
- In Vercel → **Deployments** → open the latest deployment → **⋯** → **Redeploy** (or wait for the automatic deploy from the push).
- After the deploy finishes, do a **hard refresh** on the site (Ctrl+Shift+R or Cmd+Shift+R) so the browser doesn’t use an old cached bundle.

If “hi” still doesn’t appear, open the **Build Logs** for the latest deployment and confirm the build runs `cd frontend && npm run build` and that it finishes without errors.
