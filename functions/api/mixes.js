// functions/api/mixes.js
//
// Cloudflare Pages Function — serves NLTDF's Spotify mixes to visitors.
//
// ARCHITECTURE (as of Aug 2026): this function no longer calls Spotify's
// API directly. A separate standalone Cloudflare Worker,
// nltdf-mixes-refresher (own repo, own wrangler.jsonc, hourly Cron
// Trigger — Pages Functions don't support Cron Triggers, only standalone
// Workers do), fetches fresh mixes from Spotify once per hour and writes
// the result to the MIXES_BACKUP KV namespace. This function's only job
// is to read that KV entry and serve it.
//
// WHY: previously, this function called Spotify live whenever a
// visitor's request hit an expired edge cache, meaning Spotify call
// volume scaled with visitor traffic. That caused repeated Development
// Mode QUOTA_EXCEEDED blocks, including on NLTDF's actual crew launch
// day. Decoupling Spotify calls onto a fixed hourly schedule (24
// calls/day, regardless of visitor volume) makes quota exhaustion far
// less likely under normal use. See PROJECT_NOTES.md for the full
// history of this change.
//
// Required Cloudflare Pages KV binding:
//   MIXES_BACKUP — same namespace the nltdf-mixes-refresher Worker
//   writes to. Set up in Settings -> Bindings.
//
// This function no longer needs SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET
// / SPOTIFY_REFRESH_TOKEN — those now live only on the
// nltdf-mixes-refresher Worker (set via `wrangler secret put`, not
// Cloudflare Pages env vars). They can be removed from this Pages
// project's env vars if desired, though leaving them doesn't cause harm.

const BACKUP_KV_KEY = 'mixes-backup';

export async function onRequestGet(context) {
  const { env } = context;

  if (!env.MIXES_BACKUP) {
    return jsonResponse({ error: 'MISSING_KV_BINDING' }, 500);
  }

  try {
    const backupRaw = await env.MIXES_BACKUP.get(BACKUP_KV_KEY);
    if (!backupRaw) {
      // The refresher Worker hasn't run yet (e.g. brand new setup, or
      // KV was cleared). Nothing to serve — this is a real "no data"
      // state, not an error state.
      return jsonResponse({ mixes: [], generatedAt: null });
    }

    const backup = JSON.parse(backupRaw);
    return jsonResponse({ mixes: backup.mixes || [], generatedAt: backup.savedAt || null });
  } catch (err) {
    return jsonResponse({ error: 'FETCH_FAILED', message: String(err && err.message || err) }, 502);
  }
}

function jsonResponse(body, status = 200) {
  // No Cache-Control needed here — the data is already only as fresh as
  // the hourly refresh Worker makes it, and Cloudflare KV reads are fast
  // and cheap on their own. No need to layer an additional edge cache on
  // top.
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
