// functions/api/liked-tracks.js
//
// Cloudflare Pages Function — serves the enriched liked tracks library to
// the password-protected /library.html page.
//
// Pattern matches admin-apple-music.js exactly: password sent as a query
// param, validated against the ADMIN_PASSWORD env var (same password used
// by admin.html and admin-events.html — no new credential to manage).
//
// POST (added Oct 8 2026 MT, backlog B-26) saves a stand-in key/BPM that Dan
// picks in library.html for a track FreqBlog hasn't catalogued yet. Stored in
// its own KV key (USER_FALLBACKS_KV_KEY), never in liked-tracks-data, so the
// Worker's daily overwrite can't touch it.
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
const USER_FALLBACKS_KV_KEY = 'liked-tracks-user-fallbacks';

// The 24 valid Camelot codes: 1A..12A, 1B..12B.
const CAMELOT_KEYS = new Set(
  Array.from({ length: 12 }, (_, i) => [`${i + 1}A`, `${i + 1}B`]).flat()
);

// Fields that get flagged as `provisional` on a track when a stand-in value
// (user or code fallback) filled them instead of FreqBlog. library.html uses
// the flag to style the key pill and make it editable.
const PROVISIONAL_FIELDS = ['camelot', 'bpm'];

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

// Priority per field: MANUAL_OVERRIDES > FreqBlog (the KV value) >
// user fallbacks (set from library.html) > MANUAL_FALLBACKS (code).
// Fallbacks of either kind only fill a field that is still null.
function applyManualOverrides(tracks, userFallbacks = {}) {
  if (!Array.isArray(tracks)) return tracks;
  return tracks.map((t) => {
    const override = MANUAL_OVERRIDES[t.id];
    const userFb = userFallbacks[t.id];
    const codeFb = MANUAL_FALLBACKS[t.id];
    if (!override && !userFb && !codeFb) return t;
    let out = { ...t };
    const provisional = [];
    for (const fb of [userFb, codeFb]) {
      if (!fb) continue;
      for (const [k, v] of Object.entries(fb)) {
        if (k === 'setAt' || v == null) continue;
        if (out[k] == null) {
          out[k] = v;
          if (PROVISIONAL_FIELDS.includes(k)) provisional.push(k);
        }
      }
    }
    if (override) {
      out = { ...out, ...override };
      // A hard override is a deliberate correction, not a stand-in.
      for (const k of Object.keys(override)) {
        const i = provisional.indexOf(k);
        if (i !== -1) provisional.splice(i, 1);
      }
    }
    if (provisional.length) out.provisional = provisional;
    return out;
  });
}

async function readUserFallbacks(env) {
  try {
    const fb = await env.LIKED_TRACKS.get(USER_FALLBACKS_KV_KEY, 'json');
    return fb && typeof fb === 'object' ? fb : {};
  } catch {
    return {}; // never let a bad fallbacks blob break the library page
  }
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
    const [raw, userFallbacks] = await Promise.all([
      env.LIKED_TRACKS.get(LIKED_TRACKS_KV_KEY),
      readUserFallbacks(env),
    ]);
    if (!raw) {
      return jsonResponse({ tracks: [], savedAt: null, totalLiked: 0 });
    }
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.tracks)) {
      data.tracks = applyManualOverrides(data.tracks, userFallbacks);
    }
    return jsonResponse(data);
  } catch (err) {
    return jsonResponse({ error: 'FETCH_FAILED', message: String(err && err.message || err) }, 502);
  }
}

// POST /api/liked-tracks — save or clear a stand-in key/BPM for one track.
// Body: { password, id, camelot, bpm? }  or  { password, id, clear: true }
// Returns { ok: true, track } with the track as GET would now serve it.
export async function onRequestPost(context) {
  const { env, request } = context;

  if (!env.ADMIN_PASSWORD) return jsonResponse({ error: 'MISSING_CONFIG' }, 500);
  if (!env.LIKED_TRACKS) return jsonResponse({ error: 'MISSING_KV_BINDING' }, 500);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'BAD_JSON' }, 400); }
  if (!body || !body.password || body.password !== env.ADMIN_PASSWORD) {
    return jsonResponse({ error: 'UNAUTHORIZED' }, 401);
  }

  const id = typeof body.id === 'string' ? body.id : '';
  if (!/^[A-Za-z0-9]{22}$/.test(id)) return jsonResponse({ error: 'BAD_ID' }, 400);

  const clear = body.clear === true;
  let camelot = null;
  let bpm = null;
  if (!clear) {
    camelot = typeof body.camelot === 'string' ? body.camelot.trim().toUpperCase() : '';
    if (!CAMELOT_KEYS.has(camelot)) return jsonResponse({ error: 'BAD_CAMELOT' }, 400);
    if (body.bpm != null && body.bpm !== '') {
      bpm = Number(body.bpm);
      if (!Number.isFinite(bpm) || bpm < 60 || bpm > 200) return jsonResponse({ error: 'BAD_BPM' }, 400);
      bpm = Math.round(bpm * 10) / 10;
    }
  }

  try {
    const [raw, fallbacks] = await Promise.all([
      env.LIKED_TRACKS.get(LIKED_TRACKS_KV_KEY),
      readUserFallbacks(env),
    ]);
    const data = raw ? JSON.parse(raw) : null;
    const track = data && Array.isArray(data.tracks) ? data.tracks.find((t) => t.id === id) : null;
    if (!track) return jsonResponse({ error: 'UNKNOWN_TRACK' }, 404);

    if (clear) {
      delete fallbacks[id];
    } else {
      // FreqBlog is the source of truth: refuse once it has both values,
      // since a fallback would never show anyway.
      if (track.camelot != null && track.bpm != null) {
        return jsonResponse({ error: 'HAS_FREQBLOG_DATA' }, 409);
      }
      fallbacks[id] = { camelot, ...(bpm != null ? { bpm } : {}), setAt: new Date().toISOString() };
    }

    await env.LIKED_TRACKS.put(USER_FALLBACKS_KV_KEY, JSON.stringify(fallbacks));
    const [merged] = applyManualOverrides([track], fallbacks);
    return jsonResponse({ ok: true, track: merged });
  } catch (err) {
    return jsonResponse({ error: 'SAVE_FAILED', message: String(err && err.message || err) }, 502);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
