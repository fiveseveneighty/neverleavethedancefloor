// functions/api/_apple-music-lookup.js
//
// Shared helper for looking up Apple Music playlist URLs by mix name.
// Used by mixes.js to attach an appleMusicUrl field to each mix in the
// /api/mixes response.
//
// Storage: Cloudflare KV, binding name APPLE_MUSIC_LINKS.
// Set up in Cloudflare dashboard:
//   Workers & Pages -> your Pages project -> Settings -> Bindings
//   -> Add -> KV namespace -> create/select a namespace
//   -> Variable name: APPLE_MUSIC_LINKS
//
// Key/value shape: key = mix name exactly as it appears in Spotify
// (case-sensitive, must match exactly since Apple Music has no public
// API for searching a specific account's playlists by name — see
// PROJECT_NOTES.md for why this manual-mapping approach was chosen over
// alternatives). Value = the Apple Music playlist URL, plain string.
//
// To add/update an entry via Wrangler CLI:
//   wrangler kv key put --binding=APPLE_MUSIC_LINKS "exit" "https://music.apple.com/us/playlist/exit/pl.u-xgpKVhkm4mea"
// (An admin UI for doing this from mobile is a planned follow-up — see
// PROJECT_NOTES.md open items.)

export async function attachAppleMusicUrls(env, mixes) {
  if (!env.APPLE_MUSIC_LINKS) {
    // KV binding not configured yet — degrade gracefully, no Apple Music
    // buttons render, but nothing breaks.
    return mixes;
  }

  return Promise.all(
    mixes.map(async mix => {
      try {
        const appleMusicUrl = await env.APPLE_MUSIC_LINKS.get(mix.name);
        return appleMusicUrl ? { ...mix, appleMusicUrl } : mix;
      } catch (err) {
        // A single KV lookup failing shouldn't break the mix's Spotify
        // data — just omit the Apple Music link for this one.
        return mix;
      }
    })
  );
}
