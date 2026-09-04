// functions/api/liked-tracks.js
//
// Cloudflare Pages Function — serves the enriched liked tracks library to
// the password-protected /library.html page.
//
// Pattern matches admin-apple-music.js exactly: password sent as a query
// param, validated against the ADMIN_PASSWORD env var (same password used
// by admin.html and admin-events.html — no new credential to manage).
//
// This function NEVER calls Spotify. It reads only from the LIKED_TRACKS
// KV namespace, which the separate nltdf-liked-refresher Worker populates
// on its daily cron schedule. Visitor load on /library.html therefore
// cannot trigger Spotify API calls.
//
// Required env vars (Cloudflare Pages Settings → Environment Variables):
//   ADMIN_PASSWORD — same value already set for admin.html
//
// Required KV binding (Pages Settings → Bindings):
//   LIKED_TRACKS — id c9a51f63bf1a4e2fa7da3fd18b2b3bdf
//                  (same namespace the nltdf-liked-refresher Worker writes to)

const LIKED_TRACKS_KV_KEY = 'liked-tracks-data';

export async function onRequestGet(context) {
  const { env, request } = context;

  const password = new URL(request.url).searchParams.get('password');
  if (!env.ADMIN_PASSWORD) {
    return jsonResponse({ error: 'MISSING_CONFIG' }, 500);
  }
  if (!password || password !== env.ADMIN_PASSWORD) {
    return jsonResponse({ error: 'UNAUTHORIZED' }, 401);
  }

  if (!env.LIKED_TRACKS) {
    return jsonResponse({ error: 'MISSING_KV_BINDING' }, 500);
  }

  try {
    const raw = await env.LIKED_TRACKS.get(LIKED_TRACKS_KV_KEY);
    if (!raw) {
      return jsonResponse({ tracks: [], savedAt: null, totalLiked: 0 });
    }
    return jsonResponse(JSON.parse(raw));
  } catch (err) {
    return jsonResponse({ error: 'FETCH_FAILED', message: String(err && err.message || err) }, 502);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
