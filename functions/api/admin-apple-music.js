// functions/api/admin-apple-music.js
//
// Backend for the Apple Music mapping admin page (admin.html). Protected
// by a simple shared password, checked against the ADMIN_PASSWORD env var.
// This is intentionally lightweight — fine for a single-user personal
// tool, not a substitute for real access control if this ever needs to
// support multiple people. Cloudflare Access (Zero Trust) was considered
// as a more robust alternative and may be added later; this password
// check is the interim protection until then.
//
// Required Cloudflare Pages environment variable:
//   ADMIN_PASSWORD — set as a Secret in the dashboard, Production + Preview
//
// GET  /api/admin-apple-music?password=...
//   Returns the current mixes list (name, id, existing appleMusicUrl if
//   any) so the admin page can render a picker.
//
// POST /api/admin-apple-music
//   Body: { "password": "...", "mixName": "...", "appleMusicUrl": "...", "autoRefresh": true }
//   Writes the mapping to KV. mixName must exactly match a Spotify
//   playlist name (case-sensitive) — same constraint as the manual
//   Wrangler CLI workflow this replaces. If autoRefresh is truthy, also
//   triggers an immediate nltdf-mixes-refresher run server-side (see
//   triggerMixesRefresh below) so the new link shows up on the live site
//   without waiting for the next hourly cron. The response's `refresh`
//   field carries that attempt's result; a failed/skipped refresh never
//   fails the save itself — the mapping is already written by that point.
//
//   Body: { "password": "...", "action": "refresh" }
//   Standalone trigger with no KV write — used by the admin page's
//   "Refresh live site" button (added Sep 19 2026) for the case where
//   auto-refresh is turned off, e.g. batching several link saves before
//   pushing one refresh at the end.
//
// Requires the same APPLE_MUSIC_LINKS KV binding as mixes.js.

// Same manual-trigger URL documented in claude/MIXES_WORKER.md. No auth on
// the Worker side — it's a workers.dev-only surface, not linked from the
// main site — and it's explicitly documented as safe to hit anytime: it
// checks the Spotify rate-limit KV before making any Spotify calls, so a
// blocked/back-off state just gets reported back, never bypassed.
const MIXES_REFRESH_TRIGGER_URL = 'https://nltdf-mixes-refresher.dansaltzmandesign.workers.dev/';

async function triggerMixesRefresh() {
  try {
    const res = await fetch(MIXES_REFRESH_TRIGGER_URL);
    let data = null;
    try {
      data = await res.json();
    } catch (err) {
      // Non-JSON response (shouldn't happen) — still report ok/status.
    }
    return { triggered: true, ok: res.ok, data };
  } catch (err) {
    return { triggered: false, error: String(err && err.message || err) };
  }
}

function checkPassword(env, provided) {
  if (!env.ADMIN_PASSWORD) return false;
  return provided === env.ADMIN_PASSWORD;
}

export async function onRequestGet(context) {
  const { env, request } = context;

  if (!env.APPLE_MUSIC_LINKS) {
    return jsonResponse({ error: 'MISSING_KV_BINDING' }, 500);
  }

  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';
  if (!checkPassword(env, password)) {
    return jsonResponse({ error: 'UNAUTHORIZED' }, 401);
  }

  try {
    // Get mix names from /api/mixes (names only — that part is fine to
    // come from the cached backup, since names/track counts don't change
    // often). But DON'T trust its appleMusicUrl field for mapping status:
    // /api/mixes now reads from MIXES_BACKUP, which is only refreshed
    // hourly by the standalone nltdf-mixes-refresher Worker. A mapping
    // saved just now via this admin page wouldn't be reflected there
    // until the next hourly run, which would make "Current Mixes" show
    // stale "no link" status right after a successful save. Instead,
    // check APPLE_MUSIC_LINKS directly per mix name here, live — cheap,
    // and doesn't touch Spotify at all, so no quota concern.
    const origin = new URL(request.url).origin;
    const mixesRes = await fetch(`${origin}/api/mixes`);
    if (!mixesRes.ok) throw new Error(`MIXES_FETCH_ERROR_${mixesRes.status}`);
    const mixesData = await mixesRes.json();
    const mixes = mixesData.mixes || [];

    const list = await Promise.all(
      mixes.map(async m => {
        let appleMusicUrl = null;
        try {
          appleMusicUrl = await env.APPLE_MUSIC_LINKS.get(m.name);
        } catch (err) {
          // A single lookup failing shouldn't break the whole list.
        }
        return {
          name: m.name,
          hasMapping: !!appleMusicUrl,
          appleMusicUrl,
        };
      })
    );

    return jsonResponse({ mixes: list });
  } catch (err) {
    return jsonResponse({ error: 'FETCH_FAILED', message: String(err && err.message || err) }, 502);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;

  if (!env.APPLE_MUSIC_LINKS) {
    return jsonResponse({ error: 'MISSING_KV_BINDING' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: 'INVALID_JSON' }, 400);
  }

  if (!checkPassword(env, body.password || '')) {
    return jsonResponse({ error: 'UNAUTHORIZED' }, 401);
  }

  // Standalone refresh trigger — no KV write, used by the "Refresh live
  // site" button when auto-refresh is off. See file header.
  if (body.action === 'refresh') {
    const refresh = await triggerMixesRefresh();
    return jsonResponse({ success: true, refresh });
  }

  const mixName = (body.mixName || '').trim();
  const appleMusicUrl = (body.appleMusicUrl || '').trim();

  if (!mixName) {
    return jsonResponse({ error: 'MISSING_MIX_NAME' }, 400);
  }
  if (!appleMusicUrl) {
    return jsonResponse({ error: 'MISSING_APPLE_MUSIC_URL' }, 400);
  }
  if (!appleMusicUrl.startsWith('https://music.apple.com/')) {
    return jsonResponse({ error: 'INVALID_APPLE_MUSIC_URL', message: 'URL must start with https://music.apple.com/' }, 400);
  }

  try {
    await env.APPLE_MUSIC_LINKS.put(mixName, appleMusicUrl);
  } catch (err) {
    return jsonResponse({ error: 'KV_WRITE_FAILED', message: String(err && err.message || err) }, 502);
  }

  // The mapping is already saved by this point regardless of what happens
  // below — a failed/skipped refresh is reported back but never turns a
  // successful save into an error response.
  let refresh = null;
  if (body.autoRefresh) {
    refresh = await triggerMixesRefresh();
  }

  return jsonResponse({ success: true, mixName, appleMusicUrl, refresh });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
