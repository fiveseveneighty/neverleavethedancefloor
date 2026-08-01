# NLTDF Site — Project Notes

## Context

**Never Leave the Dancefloor (NLTDF)** is a Denver-based electronic music crew — a group chat of 11 friends, run by Dan. Dan maintains the group's shared Google Calendar, sends a weekly Spotify mix to the crew, and is building this site as the group's public-facing home. Dan is also actively learning to DJ (Rekordbox, working toward a Pioneer controller purchase), with a genre focus on underground electronic/techno — that's the sensibility the site should reflect, not a generic "EDM festival" vibe.

**Audience**: primarily the 11-person crew and their extended circle right now, with the site built to be genuinely public-facing as it matures — not a private tool. Treat it as semi-public: real design effort matters, but it doesn't need enterprise polish or heavy SEO/marketing thinking. It should feel like an underground crew's page, not a startup landing page.

**Look and feel established so far**: dark, atmospheric, single-page design. Josefin Sans typeface. Background/logo as real image assets (not generated). This aesthetic direction is intentional — maintain it rather than defaulting to a more generic or corporate style when adding new sections.

**Data conventions worth respecting** (already established, don't relitigate): show events always end 11:59 PM same day (never span midnight); multi-artist bills are comma-separated; Red Rocks shows are labeled "· Denver" by convention even though the venue is technically in Morrison, CO; calendar descriptions are three lines — venue, genre/vibe, ticket URL (omitted if unavailable).

**Dan's working style**: prefers direct, concise communication; flags confusion immediately; dislikes re-covering settled ground. High-trust, batch-review style — comfortable reviewing a full plan once and approving in one pass rather than needing every step re-confirmed. Iterates visually on design before wiring up functionality.

**Is this a coding-skill project for Dan, or a pure delegation?** Worth clarifying directly with Dan early in a Code session if it's unclear — it changes how much explanation vs. just-do-it is useful.

---

## Technical Notes

Written after a long debugging session that got the Spotify mixes integration fully working server-side. Read this before making changes — several of these were non-obvious and cost real time to discover.

## Architecture

- **Hosting**: Cloudflare Pages, auto-deploys on push to `main`
- **Live URLs**: `neverleavethedancefloor.com` and `neverleavethedancefloor.pages.dev` (both point at the same Production deployment — pushing to `main` updates both simultaneously, there's no way to stage on one without the other)
- **Repo**: `github.com/fiveseveneighty/neverleavethedancefloor`, local at `~/Sites/neverleavethedancefloor/`
- **Frontend**: single `index.html`, vanilla JS, no build step
- **Backend**: Cloudflare Pages Functions in `functions/api/`

## Spotify mixes integration (functions/api/mixes.js)

**Auth**: Uses a Refresh Token flow, NOT Client Credentials. Spotify's February 2026 API policy changes block Client Credentials tokens from accessing `/v1/users/{id}/playlists` and similar user-data endpoints (403). The current setup:
- Site owner (fiveseveneighty) did a one-time Authorization Code flow with `playlist-read-private playlist-read-collaborative` scopes
- Resulting refresh token stored in Cloudflare as `SPOTIFY_REFRESH_TOKEN`
- Function exchanges it for a fresh access token on each cold request, then calls `/v1/me/playlists`
- If this ever breaks (refresh token revoked, password change, etc.), redo the Authorization Code flow as fiveseveneighty and update the env var

**Required Cloudflare env vars** (Production + Preview): `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`

**API gotchas discovered the hard way**:
- `/v1/playlists/{id}/tracks` is deprecated and now returns 403. Use `/v1/playlists/{id}/items` instead.
- The nested object under `/items` is called `item`, not `track` (e.g. `item.duration_ms`, not `track.duration_ms`).
- `tracks.total` as a `fields` param silently returns nothing now. Use `items.total`.
- Playlists returned by `/v1/me/playlists` include both **owned** and **followed** playlists. Followed (not-owned) playlists 403 on `/items` even when `public: true`. Filter to `owner.id === 'fiveseveneighty'` before fetching item details.
- There is no playlist creation-date field in the API. `oldestAddedAt` (earliest track's `added_at`) is used as a proxy for "when this mix was made," and mixes are sorted by that — NOT `newestAddedAt`, which reflects last-edit time and causes re-edited playlists to jump out of sequence.

**Cloudflare Workers subrequest cap**: Workers enforce a hard cap on total subrequests per invocation (a cumulative count, not a rate limit). At ~100+ playlists this was being exceeded, causing silent skipped playlists. Fixed by:
1. Reusing playlist metadata (name/images/external_urls/items.total) already present in the `/v1/me/playlists` listing, instead of a redundant per-playlist meta fetch — halved subrequests
2. Filtering to owned playlists only (removes followed-playlist fetches entirely)

At current playlist count (~50 public owned mixes) this is comfortably under the cap. If the playlist count grows substantially, watch for this recurring — the fix is reducing total subrequests further (e.g. independent per-playlist caching), not tuning batch concurrency, which doesn't affect the cap.

**No date filtering**: Originally filtered mixes to those created after March 2026 (to hide pre-NLTDF playlists). This filter was removed after a manual playlist cleanup — every owned+public playlist is now a legitimate mix. If old/irrelevant playlists reappear, that's a Spotify-side cleanup task, not something to re-add filtering logic for.

**Response shape**: `{ mixes: [...], generatedAt }`. Each mix has `id, name, image, url, trackCount, totalDurationMs, newestAddedAt, oldestAddedAt`. Cached at Cloudflare's edge for 10 minutes (`CACHE_TTL_SECONDS`). Add `?debug=1` to bypass cache and get a `counts` breakdown (total/owned/public/fetched/qualifying) plus `sampleErrors` — useful for diagnosing playlist-count issues without guessing.

## Frontend (index.html)

- Fetches `/api/mixes`, no client-side Spotify calls, no visitor OAuth
- Shows first 4 mixes grouped by month (via `oldestAddedAt`), "+N More" button reveals the rest from already-fetched data (no extra network call)
- YouTube section (`YT_API_KEY`, `YT_PLAYLIST_ID`) and Google Calendar section are separate, untouched by tonight's work — but likely have their own version of the Spotify deprecation problem (see To-Do below)

## Known open items / v1 TODO

Roughly in suggested order:

1. **Harden YouTube playlist feed** — same failure pattern as Spotify is plausible (deprecated fields, quota limits). Treat as its own debugging pass, don't assume it's fine because it "hasn't broken yet."
2. **Calendar display updates** — lower risk, Google Calendar API integration is already stable (see calendar conventions in memory: events end 11:59 PM same day, multi-artist bills comma-separated, Red Rocks labeled "· Denver" despite being in Morrison CO).
3. **Pagination refinements** — base "+N More" logic is solid post-tonight; further tuning is refinement, not rebuild.
4. **Apple Music playlist matching** — genuinely new territory. Different auth model (MusicKit/JWT developer tokens + user tokens), and catalog matching against Spotify's playlists likely needs ISRC-based track matching, which can be slow/incomplete. Scope this as its own investigation before committing to an implementation approach.
5. **Mobile responsive pass** — do this after the above settle, so layout work isn't chasing a moving data layer.

## Debugging approach that worked

When something 403s or behaves unexpectedly against a third-party API, verify directly with `curl` before rewriting code — don't guess at fixes. Several rounds tonight were wasted on plausible-sounding theories (cache staleness, encoding issues) that a two-minute curl test would have ruled out immediately. The `?debug=1` pattern (bypass cache, return diagnostic counts) was worth building into `mixes.js` and is worth replicating for YouTube/Apple Music work.
