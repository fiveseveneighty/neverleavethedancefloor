// functions/api/sets.js
//
// Cloudflare Pages Function — serves NLTDF's YouTube "sets" playlist to
// visitors server-side. Previously this was done client-side directly
// from index.html, which exposed the YouTube API key in page source and
// had no caching (every visitor triggered fresh Google API calls). This
// function fixes both: the key stays server-side only, and results are
// cached at Cloudflare's edge.
//
// Required Cloudflare Pages environment variable:
//   YOUTUBE_API_KEY
//
// Set this in the Cloudflare dashboard:
//   Pages project -> Settings -> Environment variables (Production + Preview)
// Never commit this value to the repo.
//
// NOTE: this key was previously public (visible in index.html page
// source) before this migration. If it hasn't already been rotated,
// consider generating a new key in Google Cloud Console and updating
// this env var — the old key may still be usable by anyone who saved a
// copy of the old page source.

const YT_PLAYLIST_ID = 'PLilRFyj4i-3GrbHBLl9Ldeim7CTI5jDEc';
const MAX_RESULTS = 50; // fetch enough for real pagination; YouTube's per-page max
const CACHE_TTL_SECONDS = 600; // 10 minutes, matching mixes.js

export async function onRequestGet(context) {
  const { env, request } = context;

  const cacheKey = new Request(new URL(request.url).toString(), request);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  if (!env.YOUTUBE_API_KEY) {
    return jsonResponse({ error: 'MISSING_CREDENTIALS' }, 500);
  }

  try {
    const items = await getPlaylistItems(env.YOUTUBE_API_KEY);
    const videoIds = items.map(i => i.snippet?.resourceId?.videoId).filter(Boolean);
    const durations = await getDurations(env.YOUTUBE_API_KEY, videoIds);

    const sets = items
      .map(item => summarize(item, durations))
      .filter(Boolean);

    const debug = new URL(request.url).searchParams.get('debug');
    const payload = { sets, generatedAt: new Date().toISOString() };
    if (debug) {
      payload.counts = { itemsFetched: items.length, videoIdsResolved: videoIds.length, setsReturned: sets.length };
    }

    const response = jsonResponse(payload, 200, debug ? null : CACHE_TTL_SECONDS);
    if (!debug) context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    return jsonResponse({ error: 'FETCH_FAILED', message: String(err && err.message || err) }, 502);
  }
}

async function getPlaylistItems(apiKey) {
  const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=${MAX_RESULTS}&playlistId=${YT_PLAYLIST_ID}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`PLAYLIST_ITEMS_ERROR_${res.status}${errText ? `: ${errText.slice(0, 200)}` : ''}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`PLAYLIST_ITEMS_API_ERROR: ${JSON.stringify(data.error).slice(0, 200)}`);
  return data.items || [];
}

async function getDurations(apiKey, videoIds) {
  if (!videoIds.length) return {};
  const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoIds.join(',')}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    // Durations are nice-to-have, not critical — degrade gracefully rather
    // than failing the whole response if this call has a problem.
    return {};
  }
  const data = await res.json();
  const durations = {};
  (data.items || []).forEach(v => {
    durations[v.id] = v.contentDetails?.duration || null;
  });
  return durations;
}

function summarize(item, durations) {
  const videoId = item.snippet?.resourceId?.videoId;
  if (!videoId) return null;
  const title = item.snippet?.title || 'Untitled';
  const thumb = item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null;
  const publishedAt = item.snippet?.publishedAt || null;

  return {
    id: videoId,
    title,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnail: thumb,
    durationISO: durations[videoId] || null,
    publishedAt,
  };
}

function jsonResponse(body, status = 200, cacheTtlSeconds = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (cacheTtlSeconds) headers['Cache-Control'] = `public, max-age=${cacheTtlSeconds}`;
  return new Response(JSON.stringify(body), { status, headers });
}
