# Roam Trips — Tour Saver (Vercel)

A tiny site that saves vetted tours to Airtable. No Claude API key, no API costs.
Claude scores tours in chat → you paste the result here → it saves to Airtable.

## What's in here
- `index.html` — the form (paste scorecard JSON, add affiliate link, save)
- `api/save.js` — server function that writes to Airtable (runs on Vercel)

## One-time setup (all in the browser, ~15 min)

### 1. Put these files on GitHub
1. Go to github.com → sign in (or sign up, free)
2. Click **+** (top right) → **New repository**
3. Name it `roam-saver`, keep it Private, click **Create repository**
4. On the next page click **uploading an existing file**
5. Drag in `index.html` AND the `api` folder (with `save.js` inside)
6. Click **Commit changes**

### 2. Deploy on Vercel
1. Go to vercel.com → sign in with your GitHub account (free)
2. Click **Add New → Project**
3. Find `roam-saver` → click **Import**
4. Before deploying, open **Environment Variables** and add:
   - Name: `AIRTABLE_API_KEY`
   - Value: your Airtable personal access token
5. Click **Deploy**
6. After ~30s you get a live URL like `https://roam-saver.vercel.app`

### 3. Use it
1. Paste a tour into your Claude chat → Claude gives you a scorecard JSON block
2. Open your Vercel URL
3. Paste the JSON, add the affiliate link from your GYG/Viator dashboard
4. Hit **Save to Airtable**
5. Sync Framer → the new tour card appears on your site

## Notes
- The Airtable base and table IDs are set inside `api/save.js`. If they ever change, edit that file.
- The Airtable key lives only in Vercel's environment variables, never in the page.
