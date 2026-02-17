# Protecting Your YouTube API Key From Being Drained by Researchers

You’re worried researchers will use up your quota and you’ll have to keep creating new keys. Here are practical ways to reduce that risk **without changing your app code**.

---

## 1. **Set up quota alerts in Google Cloud**

- In [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **YouTube Data API v3** → **Quotas**.
- Create an **alert** when usage reaches e.g. 50% or 80% of daily quota.
- You get an email before the key is fully drained so you can pause access or switch keys.

**Effort:** Low. **Impact:** You’re warned instead of surprised.

---

## 2. **Request a higher quota**

- Same place: **Quotas** for YouTube Data API v3.
- Use “Edit quotas” / “Request quota increase” and ask for more units per day (e.g. 50k or 100k).
- Google often approves reasonable increases for valid use cases.

**Effort:** One form. **Impact:** Same key lasts longer under heavy use.

---

## 3. **Give each research group their own API key**

- Create **separate Google Cloud projects** (or separate keys in one project) per research group or lab.
- Each group gets their own key and their own 10k (or increased) quota.
- Your key is only for you/demos; their usage doesn’t drain yours.

**Effort:** Medium (you create keys and send them). **Impact:** Your key is protected; they manage their own quota.

---

## 4. **Restrict the key so only your app can use it**

- In **APIs & Services** → **Credentials** → your API key → **Edit**.
- **Application restrictions:** e.g. “HTTP referrers” and add your frontend URL (e.g. `https://yoursite.com/*`), or “IP addresses” and add your server IP(s).
- **API restrictions:** “Restrict key” and allow only **YouTube Data API v3**.

Then only traffic from your app (or server) can use the key; random people or scripts can’t abuse it.

**Effort:** Low. **Impact:** Reduces abuse and accidental leakage.

---

## 5. **Use multiple keys and rotate when one is low**

- Create 2–3 API keys (e.g. in the same or different projects).
- Use **one** in the app (via `YOUTUBE_API_KEY`).
- When that key’s quota is used for the day, switch the env var to the next key and restart the backend.
- Next day the first key’s quota resets; you can rotate back.

**Effort:** Low (no code change; you just change env var and restart). **Impact:** More analyses per day without requesting a single huge quota.

---

## 6. **Limit who can use the app**

- Don’t publish the URL widely; share only with a small set of researchers.
- Or put the app behind **login** (e.g. university SSO) and invite only approved people.
- Fewer users ⇒ less quota usage.

**Effort:** Depends (e.g. adding auth is a code change; “don’t share the link” is none). **Impact:** Directly limits who can drain the key.

---

## 7. **Tell researchers about the cache**

- Your backend **already caches** comments by video ID; re-analyzing the same video doesn’t call the API again.
- In docs or a short email, ask researchers to **reuse results** for the same video instead of hitting “Analyze” many times on the same URL.
- That reduces redundant quota use without any code change.

**Effort:** One short note. **Impact:** Fewer unnecessary API calls.

---

## 8. **Optional: rate limiting (would need code later)**

- In the future you could add **rate limiting** (e.g. max N analyses per IP per hour).
- Not modifying code now; just noting it as an option if you later want to cap usage per user/IP.

---

## Suggested combination (no code changes)

1. **Restrict the key** (referrer or IP) so only your app can use it.  
2. **Set quota alerts** at 70–80% so you know before the key is drained.  
3. **Request a quota increase** so one key lasts longer.  
4. **Create a second key** and keep it as backup; when the first hits quota, switch `YOUTUBE_API_KEY` to the second and restart.  
5. **Document** for researchers that the same video is cached and they should avoid re-analyzing the same URL repeatedly.

That way you protect the key, get early warning, and have a simple way to “get a new one” by rotating to a backup key instead of creating a new key from scratch every time.
