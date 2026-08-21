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

import { attachAppleMusicUrls } from './_apple-music-lookup.js';

const SPOTIFY_OWNER_ID = 'fiveseveneighty';
const CACHE_TTL_SECONDS = 1800; // 30 minutes — increased from 10 min after
// repeated Spotify Development Mode QUOTA_EXCEEDED blocks. Development
// Mode has a real, recurring quota ceiling (not just a one-time testing
// artifact); a longer cache means fewer real Spotify API calls under
// normal visitor traffic, at the cost of new mixes taking up to 30 min
// to appear after being posted. 30 min was chosen as a balance between
// quota safety and not delaying mix announcements too long. See
// PROJECT_NOTES.md.

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
    // Only playlists fiveseveneighty actually owns. Followed playlists
    // (owned by other Spotify users) 403 on the /items endpoint even when
    // marked public — Spotify restricts item-level access to owned
    // playlists under this API version. Filtering here also trims
    // subrequest count for free.
    const ownedCandidates = candidates.filter(p => p?.owner?.id === SPOTIFY_OWNER_ID);
    const publicCandidates = ownedCandidates.filter(p => p && p.public !== false);

    // Fetch meta + tracks for every candidate, in small sequential batches.
    // Note: Cloudflare Workers enforces a hard cap on total subrequests per
    // invocation (not a concurrency/rate limit — a cumulative count). With
    // ~46 owned+public playlists this sits right at that ceiling, so an
    // occasional single playlist may be skipped with a "too many
    // subrequests" error on a given run. That playlist will simply appear
    // on the next cache refresh (10 min) instead. If this becomes a
    // frequent, larger gap as the playlist count grows, the fix is to
    // reduce total subrequests further (e.g. paginate playlist fetching
    // itself, cache per-playlist results independently) rather than tune
    // batch size, which doesn't affect the total-count cap.
    // With 100+ playlists on this account, firing everything at once in a
    // single Promise.all (2 requests per playlist) risks Spotify rate
    // limiting and Cloudflare Workers' subrequest limits. BATCH_SIZE keeps
    // concurrency modest; the whole thing is cached for CACHE_TTL_SECONDS
    // afterward so this cost is only paid occasionally, not per visitor.
    const { results: details, errors: fetchErrors } = await fetchDetailsInBatches(token, publicCandidates, 5);

    // Every owned, public playlist is now a legitimate mix (playlists that
    // predate NLTDF or don't belong have been cleaned up manually), so no
    // date filtering is needed — just summarize everything that made it
    // through the owner/public/fetch-success filters above.
    const qualifying = details.map(({ playlist, detail }) => summarize(playlist, detail));

    // Most recently created mix first. Uses oldestAddedAt (earliest track's
    // added_at) as a proxy for playlist creation date, so a playlist that
    // gets edited/added-to later doesn't jump to the top out of sequence.
    qualifying.sort((a, b) => {
      if (!a.oldestAddedAt) return 1;
      if (!b.oldestAddedAt) return -1;
      return new Date(b.oldestAddedAt) - new Date(a.oldestAddedAt);
    });

    // Attach Apple Music URLs where a manual mapping exists (see
    // _apple-music-lookup.js). Mixes without a mapping just don't get an
    // appleMusicUrl field — the frontend skips the button in that case.
    const withAppleMusic = await attachAppleMusicUrls(env, qualifying);

    const debug = new URL(request.url).searchParams.get('debug');
    const payload = { mixes: withAppleMusic, generatedAt: new Date().toISOString() };
    if (debug) {
      const subrequestCapErrors = fetchErrors.filter(e => /too many subrequests/i.test(e.error));
      const spotify403Errors = fetchErrors.filter(e => /PLAYLIST_ITEMS_ERROR_403/.test(e.error));
      const otherErrors = fetchErrors.filter(
        e => !/too many subrequests/i.test(e.error) && !/PLAYLIST_ITEMS_ERROR_403/.test(e.error)
      );
      payload.counts = {
        totalPlaylists: candidates.length,
        ownedPlaylists: ownedCandidates.length,
        publicPlaylists: publicCandidates.length,
        detailsFetched: details.length,
        skippedDueToError: publicCandidates.length - details.length,
        skippedDueToSubrequestCap: subrequestCapErrors.length,
        skippedDueToSpotify403: spotify403Errors.length,
        skippedDueToOtherError: otherErrors.length,
        qualifying: qualifying.length,
      };
      payload.sampleErrors = fetchErrors.slice(0, 15);
    }

    const response = jsonResponse(payload, 200, debug ? null : CACHE_TTL_SECONDS);
    if (!debug) context.waitUntil(cache.put(cacheKey, response.clone()));
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
  const errors = [];
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
          // down the entire mixes list. Record why, for debug mode.
          errors.push({ id: p.id, name: p.name, error: String(err.message || err) });
          return null;
        }
      })
    );
    results.push(...batchResults.filter(Boolean));
  }
  return { results, errors };
}

async function fetchPlaylistDetail(token, id) {
  // Only fetch the items/tracks list here — name, images, external_urls,
  // and items.total are already present on the playlist object returned by
  // /v1/me/playlists (see getUserPlaylists), so we don't need a second
  // request per playlist just to re-fetch them. This halves the subrequest
  // count, which matters a lot with 100+ playlists on one Cloudflare
  // Worker invocation (Workers has a hard cap on total subrequests per
  // invocation, separate from any rate limiting).
  const itemsRes = await fetch(
    `https://api.spotify.com/v1/playlists/${id}/items?fields=items(added_at,item(duration_ms))&limit=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!itemsRes.ok) throw new Error(`PLAYLIST_ITEMS_ERROR_${itemsRes.status}`);
  const itemsData = await itemsRes.json();
  return {
    entries: itemsData.items || [],
  };
}

function summarize(playlist, detail) {
  const entries = detail.entries || [];
  const totalMs = entries.reduce((sum, e) => sum + (e.item?.duration_ms || 0), 0);
  const dates = entries.map(e => (e.added_at ? new Date(e.added_at) : null)).filter(Boolean);
  const newest = dates.length ? new Date(Math.max(...dates)) : null;
  // Spotify's API has no true playlist creation-date field, so the
  // earliest track's added_at is used as a proxy for "when this mix was
  // made" — much more stable than newestAddedAt for playlists that aren't
  // edited after the fact (which is the normal case for these mixes).
  const oldest = dates.length ? new Date(Math.min(...dates)) : null;
  const img = playlist.images?.[0]?.url || null;
  const url = playlist.external_urls?.spotify || `https://open.spotify.com/playlist/${playlist.id}`;

  return {
    id: playlist.id,
    name: playlist.name,
    image: img,
    url,
    trackCount: playlist.items?.total ?? entries.length,
    totalDurationMs: totalMs,
    newestAddedAt: newest ? newest.toISOString() : null,
    oldestAddedAt: oldest ? oldest.toISOString() : null,
  };
}

function jsonResponse(body, status = 200, cacheTtlSeconds = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (cacheTtlSeconds) headers['Cache-Control'] = `public, max-age=${cacheTtlSeconds}`;
  return new Response(JSON.stringify(body), { status, headers });
}
