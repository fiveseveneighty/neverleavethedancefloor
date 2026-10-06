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

// Manual data-quality overrides for individual tracks.
//
// FreqBlog (our BPM/Camelot source, see claude/LIKED_WORKER.md) is an
// algorithmic key/BPM detection service and occasionally gets a track
// wrong -- most commonly a major/minor (mode) mix-up on the same root
// note (e.g. returning a Db-minor Camelot code for a track that's
// actually Db major). When Dan catches one of these against Spotify's
// own displayed key, add an entry below rather than waiting on FreqBlog
// to (maybe) fix it. Applied here at request time, so it takes effect
// on the next page load -- no Worker redeploy or KV backfill needed.
// Only the fields present in an override are changed; everything else
// on the track passes through untouched.
//
// Key: Spotify track ID (the same `id` field on each track object).
const MANUAL_OVERRIDES = {
  // "Let's Begin" -- Devault. FreqBlog returned 12A (Db minor); Spotify's
  // own Camelot badge (seen in the iOS app's playlist editor) shows 3B
  // (Db major) for the same track. Corrected Sep 16 2026 MT.
  '0rln7cFteLIh27eT02rr6q': { camelot: '3B' },

  // "Paradise" -- Cloonee, Chris Lake, Aliyah's Interlude. Brand-new release
  // not yet in FreqBlog. Key/BPM from Beatport (Ab major = 4B, 130 BPM).
  // Spotify shows 4A (Ab minor) -- Dan's rule: Beatport wins over Spotify
  // for key. Added Oct 6 2026 MT.
  '4TCzyYDyqYbLlNC1Z8Ewiu': { bpm: 130, camelot: '4B' },

  // "Kill The Noise (Interlude)" -- Cloonee, Harvey Whyte. Same situation;
  // Beatport 128 BPM, C minor = 5A (Spotify agrees). Added Oct 6 2026 MT.
  '0a9j1enjxmEuEZy6B6NDng': { bpm: 128, camelot: '5A' },
};

// Stopgap values used ONLY while the track's own field is still null --
// unlike MANUAL_OVERRIDES above, these never win over real data. Once the
// liked-refresher Worker backfills the field from FreqBlog, the real value
// shows through and the entry here is ignored (safe to delete later).
// durationMs values are rounded to the second, read from Spotify's app.
const MANUAL_FALLBACKS = {
  '4TCzyYDyqYbLlNC1Z8Ewiu': { durationMs: 164000 }, // Paradise, 2:44
  '0a9j1enjxmEuEZy6B6NDng': { durationMs: 138000 }, // Kill The Noise (Interlude), 2:18
};

function applyManualOverrides(tracks) {
  if (!Array.isArray(tracks)) return tracks;
  return tracks.map((t) => {
    const override = MANUAL_OVERRIDES[t.id];
    const fallback = MANUAL_FALLBACKS[t.id];
    let out = t;
    if (fallback) {
      out = { ...out };
      for (const [k, v] of Object.entries(fallback)) {
        if (out[k] == null) out[k] = v;
      }
    }
    return override ? { ...out, ...override } : out;
  });
}

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
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.tracks)) {
      data.tracks = applyManualOverrides(data.tracks);
    }
    return jsonResponse(data);
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
