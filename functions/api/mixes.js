// functions/api/mixes.js
//
// Cloudflare Pages Function — serves NLTDF's Spotify mixes to visitors
// without requiring visitor OAuth.
//
// NOTE: Spotify's February 2026 API changes restrict the Client
// Credentials flow from accessing user/playlist data (403 on
// /v1/users/{id}/playlists and similar endpoints). This function
// instead uses a Refresh Token flow: the site owner (fiveseveneighty)
// authorized once via the Authorization Code flow, and the resulting
// long-lived refresh token (stored as a Cloudflare secret) is used to
// mint a fresh access token on each cold request. That access token
// is used against /v1/me/playlists, which works for user-authorized
// tokens.
//
// Required Cloudflare Pages environment variables:
//   SPOTIFY_CLIENT_ID
//   SPOTIFY_CLIENT_SECRET
//   SPOTIFY_REFRESH_TOKEN
//
// Set these in the Cloudflare dashboard:
//   Pages project -> Settings -> Environment variables (Production + Preview)
// Never commit these values to the repo.
//
// If SPOTIFY_REFRESH_TOKEN ever stops working (revoked, password change,
// etc.), redo the one-time Authorization Code flow as fiveseveneighty and
// update this env var with the new refresh token.

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

  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET || !env.SPOTIFY_REFRESH_TOKEN) {
    return jsonResponse({ error: 'MISSING_CREDENTIALS' }, 500);
  }

  try {
    const token = await getAccessTokenFromRefreshToken(env);
    const candidates = await getUserPlaylists(token);
    const publicCandidates = candidates.filter(p => p && p.public !== false);

    // Fetch meta + tracks for every candidate, in small sequential batches.
    // With 100+ playlists on this account, firing everything at once in a
    // single Promise.all (2 requests per playlist) risks Spotify rate
    // limiting and Cloudflare Workers' subrequest limits. BATCH_SIZE keeps
    // concurrency modest; the whole thing is cached for CACHE_TTL_SECONDS
    // afterward so this cost is only paid occasionally, not per visitor.
    const details = await fetchDetailsInBatches(token, publicCandidates, 5);

    // Apply the same cutoff rule the frontend used:
    //   - if a playlist has no dated tracks, include it
    //   - otherwise include it only if its EARLIEST track date is on or
    //     after MIXES_SINCE
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

async function getAccessTokenFromRefreshToken(env) {
  const basic = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: env.SPOTIFY_REFRESH_TOKEN,
  }).toString();
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`TOKEN_ERROR_${res.status}${errText ? `: ${errText.slice(0, 200)}` : ''}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('TOKEN_MISSING');
  return data.access_token;
}

async function getUserPlaylists(token) {
  let playlists = [];
  let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
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

async function fetchDetailsInBatches(token, playlists, batchSize) {
  const results = [];
  for (let i = 0; i < playlists.length; i += batchSize) {
    const batch = playlists.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async p => {
        try {
          const detail = await fetchPlaylistDetail(token, p.id);
          return { playlist: p, detail };
        } catch (err) {
          // Skip a single problem playlist rather than failing the whole
          // response — a transient error on one playlist shouldn't take
          // down the entire mixes list.
          return null;
        }
      })
    );
    results.push(...batchResults.filter(Boolean));
  }
  return results;
}

async function fetchPlaylistDetail(token, id) {
  const [metaRes, tracksRes] = await Promise.all([
    fetch(`https://api.spotify.com/v1/playlists/${id}?fields=name,images,external_urls,tracks.total`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    fetch(`https://api.spotify.com/v1/playlists/${id}/tracks?fields=items(added_at,track(duration_ms))&limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  ]);
  if (!metaRes.ok) throw new Error(`PLAYLIST_META_ERROR_${metaRes.status}`);
  if (!tracksRes.ok) throw new Error(`PLAYLIST_TRACKS_ERROR_${tracksRes.status}`);
  const meta = await metaRes.json();
  const tracks = await tracksRes.json();
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
