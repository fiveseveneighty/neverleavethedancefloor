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
//   Body: { "password": "...", "mixName": "...", "appleMusicUrl": "..." }
//   Writes the mapping to KV. mixName must exactly match a Spotify
//   playlist name (case-sensitive) — same constraint as the manual
//   Wrangler CLI workflow this replaces.
//
// Requires the same APPLE_MUSIC_LINKS KV binding as mixes.js.

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
    // Reuse the existing /api/mixes endpoint rather than re-implementing
    // the Spotify fetch here — this admin page only needs names, not the
    // full mix detail.
    const origin = new URL(request.url).origin;
    const mixesRes = await fetch(`${origin}/api/mixes`);
    if (!mixesRes.ok) throw new Error(`MIXES_FETCH_ERROR_${mixesRes.status}`);
    const mixesData = await mixesRes.json();
    const mixes = mixesData.mixes || [];

    // mixes.js already attaches appleMusicUrl when present, so we can
    // read mapping status directly from it rather than querying KV again
    // per mix.
    const list = mixes.map(m => ({
      name: m.name,
      hasMapping: !!m.appleMusicUrl,
      appleMusicUrl: m.appleMusicUrl || null,
    }));

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
    return jsonResponse({ success: true, mixName, appleMusicUrl });
  } catch (err) {
    return jsonResponse({ error: 'KV_WRITE_FAILED', message: String(err && err.message || err) }, 502);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
