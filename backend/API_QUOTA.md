# YouTube API quota and publishing

## How to avoid running out of API calls

### 1. **Comment cache (built-in)**  
The API caches YouTube comments by video ID in memory. Re-analyzing the same video does **not** use extra quota.

- Cache size: **200** videos by default. Override with env: `VCM_COMMENT_CACHE_SIZE=500`.
- Disable cache (e.g. for testing): `VCM_DISABLE_CACHE=1`.

### 2. **Quota usage**  
YouTube Data API v3 has a **daily quota** (often 10,000 units). Rough costs:

- `commentThreads.list` (fetch comments): **1 unit** per request (up to 100 comments).
- `videos.list` (fetch title): **1 unit** per request.

So one “Analyze” call ≈ **2 units** (comments + title). With cache, repeat analyses of the same video use **0** extra units.

### 3. **Ways to stay within quota**

- **Rely on the cache** so the same video is not re-fetched.
- **Limit concurrent users** or add **rate limiting** (e.g. max N analyses per IP per minute) if you expect heavy traffic.
- **Request a quota increase** in [Google Cloud Console](https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas) if you need more than 10k units/day.
- **Multiple API keys**: create several projects with their own keys and rotate or load-balance (e.g. round-robin) so each key stays under its quota.

### 4. **Monitoring**  
In Google Cloud Console → APIs & Services → YouTube Data API v3 → Quotas, you can see usage. Set up alerts for when you approach the limit.

### 5. **Optional: persist cache**  
For a single server you can persist the cache to disk (e.g. JSON or SQLite by `video_id`) and reload on startup so popular videos stay cached across restarts. The current implementation is in-memory only.
