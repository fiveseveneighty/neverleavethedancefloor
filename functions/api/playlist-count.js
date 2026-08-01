// functions/api/playlist-count.js
//
// TEMPORARY diagnostic endpoint — checks how many playlists the account
// has (total / owned / public) WITHOUT fetching per-playlist item details,
// so it costs only a couple of subrequests. Used to check whether
// mixes.js's 502s are caused by the playlist count exceeding Cloudflare's
// subrequest cap (see mixes.js comments). Delete once mixes.js is fixed.

const SPOTIFY_OWNER_ID = 'fiveseveneighty';

export async function onRequestGet(context) {
  const { env } = context;

  try {
    const basic = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: env.SPOTIFY_REFRESH_TOKEN,
    }).toString();
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '');
      return json({ error: `TOKEN_ERROR_${tokenRes.status}`, detail: errText.slice(0, 200) }, 500);
    }
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;

    let playlists = [];
    let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
    let pages = 0;
    while (url) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      pages++;
      if (!res.ok) return json({ error: `SPOTIFY_ERROR_${res.status}`, pagesFetched: pages }, 500);
      const data = await res.json();
      playlists = playlists.concat(data.items || []);
      url = data.next || null;
    }

    const owned = playlists.filter(p => p?.owner?.id === SPOTIFY_OWNER_ID);
    const ownedPublic = owned.filter(p => p && p.public !== false);

    return json({
      totalPlaylists: playlists.length,
      ownedPlaylists: owned.length,
      ownedPublicPlaylists: ownedPublic.length,
      pagesFetched: pages,
      subrequestsUsedByThisCheck: pages + 1,
    });
  } catch (err) {
    return json({ error: 'DIAGNOSTIC_FAILED', message: String(err && err.message || err) }, 500);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
