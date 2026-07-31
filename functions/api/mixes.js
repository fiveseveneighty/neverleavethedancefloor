// functions/api/mixes.js
//
// Cloudflare Pages Function — serves NLTDF's Spotify mixes to visitors
// without requiring visitor OAuth. Uses the Client Credentials flow
// (Client ID + Secret, stored as Cloudflare env vars) to fetch playlists
// from the fiveseveneighty account, filters them to mixes created on or
// after MIXES_SINCE (matching the frontend's original logic exactly),
// and returns a small, pre-computed JSON payload the page can render
// directly — no client-side Spotify calls, no "+N more" pagination bugs.
//
// Required Cloudflare Pages environment variables:
//   SPOTIFY_CLIENT_ID
//   SPOTIFY_CLIENT_SECRET
//
// Set these in the Cloudflare dashboard:
//   Pages project -> Settings -> Environment variables (Production + Preview)
// Never commit the Client Secret to the repo.

const SPOTIFY_USER_ID = 'fiveseveneighty';
const MIXES_SINCE = new Date('2026-03-01');
const CACHE_TTL_SECONDS = 600; // 10 minutes

export async function onRequestGet(context) {
  const { env, request } = context;

  // Serve from Cloudflare's edge cache when possible, to avoid hitting
  // Spotify's rate limits on every visitor page load.
  const cacheKey = new Request(new URL(request.url).toString(), request);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    return jsonResponse({ error: 'MISSING_CREDENTIALS' }, 500);
  }

  try {
    const token = await getClientCredentialsToken(env);
    const candidates = await getUserPlaylists(token);
    const publicCandidates = candidates.filter(p => p && p.public !== false);

    // Fetch meta + tracks for every candidate in parallel, then apply the
    // same cutoff rule the frontend used:
    //   - if a playlist has no dated tracks, include it
    //   - otherwise include it only if its EARLIEST track date is on or
    //     after MIXES_SINCE
    const details = await Promise.all(
      publicCandidates.map(p => fetchPlaylistDetail(token, p.id).then(detail => ({ playlist: p, detail })))
    );

    const qualifying = details
      .filter(({ detail }) => {
        const items = detail.tracks?.items || [];
        const dates = items.map(t => (t.added_at ? new Date(t.added_at) : null)).filter(Boolean);
        if (!dates.length) return true;
        return new Date(Math.min(...dates)) >= MIXES_SINCE;
      })
      .map(({ playlist, detail }) => summarize(playlist, detail));

    // Newest mixes first.
    qualifying.sort((a, b) => {
      if (!a.newestAddedAt) return 1;
      if (!b.newestAddedAt) return -1;
      return new Date(b.newestAddedAt) - new Date(a.newestAddedAt);
    });

    const response = jsonResponse({ mixes: qualifying, generatedAt: new Date().toISOString() }, 200, CACHE_TTL_SECONDS);
    context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    return jsonResponse({ error: 'FETCH_FAILED', message: String(err && err.message || err) }, 502);
  }
}

async function getClientCredentialsToken(env) {
  const basic = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`TOKEN_ERROR_${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('TOKEN_MISSING');
  return data.access_token;
}

async function getUserPlaylists(token) {
  let playlists = [];
  let url = `https://api.spotify.com/v1/users/${SPOTIFY_USER_ID}/playlists?limit=50`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) throw new Error('RATE_LIMITED');
    if (!res.ok) throw new Error(`SPOTIFY_ERROR_${res.status}`);
    const data = await res.json();
    playlists = playlists.concat(data.items || []);
    url = data.next || null;
  }
  return playlists;
}

async function fetchPlaylistDetail(token, id) {
  const [meta, tracks] = await Promise.all([
    fetch(`https://api.spotify.com/v1/playlists/${id}?fields=name,images,external_urls,tracks.total`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()),
    fetch(`https://api.spotify.com/v1/playlists/${id}/tracks?fields=items(added_at,track(duration_ms))&limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()),
  ]);
  return {
    ...meta,
    tracks: {
      total: meta.tracks?.total || 0,
      items: tracks.items || [],
    },
  };
}

function summarize(playlist, detail) {
  const items = detail.tracks?.items || [];
  const totalMs = items.reduce((sum, t) => sum + (t.track?.duration_ms || 0), 0);
  const dates = items.map(t => (t.added_at ? new Date(t.added_at) : null)).filter(Boolean);
  const newest = dates.length ? new Date(Math.max(...dates)) : null;
  const img = detail.images?.[0]?.url || playlist.images?.[0]?.url || null;
  const url = detail.external_urls?.spotify || `https://open.spotify.com/playlist/${playlist.id}`;

  return {
    id: playlist.id,
    name: detail.name || playlist.name,
    image: img,
    url,
    trackCount: detail.tracks?.total || items.length,
    totalDurationMs: totalMs,
    newestAddedAt: newest ? newest.toISOString() : null,
  };
}

function jsonResponse(body, status = 200, cacheTtlSeconds = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (cacheTtlSeconds) headers['Cache-Control'] = `public, max-age=${cacheTtlSeconds}`;
  return new Response(JSON.stringify(body), { status, headers });
}
