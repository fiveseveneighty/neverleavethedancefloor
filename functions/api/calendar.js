// functions/api/calendar.js
//
// Cloudflare Pages Function — serves NLTDF's upcoming Google Calendar
// events to visitors server-side. Previously this was done client-side
// directly from index.html, which exposed the Google API key in page
// source and had no caching (every visitor triggered a fresh Calendar
// API call). This function fixes both: the key stays server-side only,
// and results are cached at Cloudflare's edge.
//
// Required Cloudflare Pages environment variable:
//   GCAL_API_KEY
//
// Set this in the Cloudflare dashboard:
//   Pages project -> Settings -> Environment variables (Production + Preview)
// Never commit this value to the repo.
//
// NOTE: this key was previously public (visible in index.html page
// source) before this migration, and was shared with the (now-rotated)
// YouTube key. Generate a fresh key in Google Cloud Console for this if
// it hasn't already been rotated — the old key may still be usable by
// anyone who saved a copy of the old page source.

const GCAL_ID = '04t6q307tih41nrcj5ue0mrunc@group.calendar.google.com';
const MAX_EVENTS = 50;
const CACHE_TTL_SECONDS = 600; // 10 minutes, matching mixes.js / sets.js

export async function onRequestGet(context) {
  const { env, request } = context;

  const cacheKey = new Request(new URL(request.url).toString(), request);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  if (!env.GCAL_API_KEY) {
    return jsonResponse({ error: 'MISSING_CREDENTIALS' }, 500);
  }

  try {
    const events = await getUpcomingEvents(env.GCAL_API_KEY);

    const debug = new URL(request.url).searchParams.get('debug');
    const payload = { events, generatedAt: new Date().toISOString() };
    if (debug) {
      payload.counts = { eventsReturned: events.length };
    }

    const response = jsonResponse(payload, 200, debug ? null : CACHE_TTL_SECONDS);
    if (!debug) context.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    return jsonResponse({ error: 'FETCH_FAILED', message: String(err && err.message || err) }, 502);
  }
}

async function getUpcomingEvents(apiKey) {
  const now = new Date().toISOString();
  const calId = encodeURIComponent(GCAL_ID);
  const url = `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?key=${apiKey}&timeMin=${now}&maxResults=${MAX_EVENTS}&singleEvents=true&orderBy=startTime`;

  const res = await fetch(url);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`CALENDAR_ERROR_${res.status}${errText ? `: ${errText.slice(0, 200)}` : ''}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`CALENDAR_API_ERROR: ${JSON.stringify(data.error).slice(0, 200)}`);

  // Pass through only the fields the frontend actually uses — keeps the
  // response small and avoids leaking any calendar metadata we don't need.
  return (data.items || []).map(e => ({
    summary: e.summary || null,
    description: e.description || null,
    start: e.start || null,
  }));
}

function jsonResponse(body, status = 200, cacheTtlSeconds = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (cacheTtlSeconds) headers['Cache-Control'] = `public, max-age=${cacheTtlSeconds}`;
  return new Response(JSON.stringify(body), { status, headers });
}
