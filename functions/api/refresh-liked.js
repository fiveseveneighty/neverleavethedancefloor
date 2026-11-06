// functions/api/refresh-liked.js
//
// Runs the nltdf-liked-refresher Worker on demand for library.html's
// ↻ Refresh button (B-28 + B-29, Nov 2026 MT). Same-origin, so the page can
// read the result (no CORS needed), and only someone with the library password
// can trigger a run. The Worker itself refuses manual runs without the secret.
//
// POST { password } → the Worker's run result JSON
//   { success, totalLiked, newTracksThisRun, freqBlogFetched, freqBlogPending, spotifyCallsThisRun, ... }
//
// Required env vars (Cloudflare Pages Settings → Environment Variables, secret):
//   ADMIN_PASSWORD       — same value as liked-tracks.js
//   LIKED_TRIGGER_SECRET — same value as the Worker's TRIGGER_SECRET
//
// Spotify quota: the Worker checks its own rate-limit key first and makes no
// Spotify calls while blocked, so a tap during a block is harmless.

const WORKER_URL = 'https://nltdf-liked-refresher.dansaltzmandesign.workers.dev/';

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.ADMIN_PASSWORD || !env.LIKED_TRIGGER_SECRET) return json({ error: 'MISSING_CONFIG' }, 500);
  let body = null;
  try { body = await request.json(); } catch (e) {}
  if (!body || !body.password || body.password !== env.ADMIN_PASSWORD) return json({ error: 'UNAUTHORIZED' }, 401);
  let resp;
  try {
    resp = await fetch(WORKER_URL, { headers: { 'X-Trigger-Secret': env.LIKED_TRIGGER_SECRET } });
  } catch (e) {
    return json({ error: 'WORKER_UNREACHABLE', detail: String(e && e.message || e) }, 502);
  }
  const text = await resp.text();
  let result;
  try { result = JSON.parse(text); } catch (e) { return json({ error: 'WORKER_ERROR', status: resp.status, detail: text.slice(0, 200) }, 502); }
  return json(result, resp.ok ? 200 : 502);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
