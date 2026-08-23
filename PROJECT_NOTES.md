# NLTDF Site — Project Notes

## Context

**Never Leave the Dancefloor (NLTDF)** is a Denver-based electronic music crew — a group chat of 11 friends, run by Dan. Dan maintains the group's shared Google Calendar, sends a weekly Spotify mix to the crew, and is building this site as the group's public-facing home. Dan is also actively learning to DJ (Rekordbox, working toward a Pioneer controller purchase), with a genre focus on underground electronic/techno — that's the sensibility the site should reflect, not a generic "EDM festival" vibe.

**Audience**: primarily the 11-person crew and their extended circle, with the site genuinely public-facing now — it's been shown to the crew and is live. Semi-public: real design effort matters, doesn't need enterprise polish or heavy SEO/marketing thinking. Should feel like an underground crew's page, not a startup landing page.

**Look and feel established so far**: dark, atmospheric, single-page design. Josefin Sans typeface. Background/logo as real image assets (not generated). Neon pink (`#e8789c`) as the accent color throughout — buttons, section labels, "Next up" badges. This aesthetic direction is intentional — maintain it rather than defaulting to a more generic or corporate style.

**Data conventions worth respecting**: show events always end 11:59 PM same day (never span midnight); multi-artist bills are comma-separated; Red Rocks shows are labeled "· Denver" by convention even though the venue is technically in Morrison, CO; calendar descriptions are three lines — venue, genre/vibe, ticket URL (genre line is no longer displayed on the site, but still present in the raw calendar description data).

**Dan's working style**: prefers direct, concise communication; flags confusion immediately; dislikes re-covering settled ground. High-trust, batch-review style. Now editing locally in VS Code (`code .` from the repo root) rather than the upload/download file-relay workflow used earlier in the project — commits and pushes directly from VS Code's integrated terminal.

**Deploys are automatic** on push to `main` (confirmed working as of Aug 2026 — earlier in the project there was real, prolonged confusion about whether Cloudflare Pages was auto-deploying or not; it is, and no manual "Retry deployment" step is needed).

---

## Architecture (current, as of Aug 2026)

- **Hosting**: Cloudflare Pages, auto-deploys on push to `main`
- **Live URLs**: `neverleavethedancefloor.com` and `neverleavethedancefloor.pages.dev` (same Production deployment)
- **Repo**: `github.com/fiveseveneighty/neverleavethedancefloor`, local at `~/Sites/neverleavethedancefloor/`
- **Frontend**: single `index.html`, vanilla JS, no build step
- **Backend**: Cloudflare Pages Functions in `functions/api/`
- **A second, separate deployable project**: `nltdf-mixes-refresher`, a standalone Cloudflare Worker (own repo/folder at `~/Sites/nltdf-mixes-refresher/`, own `wrangler.jsonc`, deployed via `wrangler deploy`, NOT part of the Pages project). See "Spotify mixes architecture" below for why this exists.

## Spotify mixes architecture — READ THIS BEFORE TOUCHING mixes.js

**This changed significantly partway through the project. The old design (Pages Function calls Spotify live on every cache-miss) is gone. Do not reintroduce it.**

### Why it changed

The original design had `functions/api/mixes.js` call Spotify directly whenever Cloudflare's edge cache expired (originally 10 min, later bumped to 30 min). This meant Spotify API call volume scaled with **visitor traffic** — the more people loaded the site, the more Spotify calls happened. Spotify's Developer Dashboard shows this app is in **Development Mode**, which has a real, recurring quota ceiling (not a one-time testing artifact). This caused repeated `429 QUOTA_EXCEEDED` blocks, including **on the crew's actual launch day**, where real visitors got "Couldn't load mixes" errors.

Extended/production quota mode was investigated and ruled out — as of Spotify's policy at time of investigation, it requires an organization account, not viable for this personal project.

### Current design

1. **`nltdf-mixes-refresher`** (standalone Worker, separate deploy) — runs on an **hourly Cron Trigger** (`0 * * * *` in its `wrangler.jsonc`). Fetches fresh data from Spotify (same owned/public-filtering logic as before), attaches Apple Music URLs (see below), and writes the result to a KV namespace called `MIXES_BACKUP` (key: `mixes-backup`, value: `{ mixes: [...], savedAt }`).
2. **`functions/api/mixes.js`** (Pages Function) — now extremely simple. **Never calls Spotify.** Just reads `MIXES_BACKUP` from KV and returns it. ~60 lines, down from ~285.
3. Visitor traffic **cannot** trigger a Spotify call, no matter how much of it there is. Spotify call volume is now fixed at 24/day regardless of site traffic.

### Why Pages Functions couldn't do this directly

Cloudflare Cron Triggers are a **Workers-only** feature — confirmed via Cloudflare's own "Migrate from Pages to Workers" docs, which lists Cron Triggers as something you gain by leaving Pages. Pages Functions do not support scheduled/cron execution. This is why a second, separate Worker project exists instead of just adding a cron config to the Pages project.

### Setup for `nltdf-mixes-refresher`

- Directory: `~/Sites/nltdf-mixes-refresher/` (`wrangler.jsonc` at root, code in `src/index.js`)
- KV bindings (in `wrangler.jsonc`): `MIXES_BACKUP` (id `08152069502b4458a63dbaeb99863a79`), `APPLE_MUSIC_LINKS` (id `f7b585c29c6f477f8e968cc8af590dde`)
- Secrets (set via `wrangler secret put NAME`, NOT Cloudflare dashboard env vars — this is a Worker, not Pages): `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`
- Also exposes an HTTP `fetch` handler (same logic as `scheduled`) at `https://nltdf-mixes-refresher.dansaltzmandesign.workers.dev/` for manual on-demand triggering — useful for testing or forcing an immediate refresh without waiting for the next hourly run. No auth on this endpoint; not linked from the main site, low-risk personal-tool exposure.
- To redeploy after code changes: `cd ~/Sites/nltdf-mixes-refresher && wrangler deploy`

### Stale-data fallback (still present, now secondary safety net)

`mixes.js`'s simplification removed the try/catch-with-Spotify-fallback pattern that used to live there, because it now literally cannot fail on Spotify's end (it never calls Spotify). If `MIXES_BACKUP` is empty (e.g. very first deploy before the Worker has ever run), it returns `{ mixes: [], generatedAt: null }` rather than erroring.

### Refresh token lifecycle

Spotify refresh tokens have a **180-day lifetime** (per the Spotify Developer Dashboard's "Basic Information" page). If it ever needs regenerating (expired, revoked, password change), redo the one-time Authorization Code flow as `fiveseveneighty`:
1. Visit `https://accounts.spotify.com/authorize?response_type=code&client_id=06532c6d580f458aba98f41fdf71f344&scope=playlist-read-private%20playlist-read-collaborative&redirect_uri=https%3A%2F%2Fneverleavethedancefloor.com` (redirect URI must exactly match one registered in the Spotify app's dashboard — currently `https://neverleavethedancefloor.com` with NO trailing slash, and `https://neverleavethedancefloor.pages.dev/` WITH one — these are registered as distinct, exact strings)
2. Log in as fiveseveneighty, approve, copy the `code` param from the redirect URL (single-use, expires in minutes)
3. Exchange it for tokens via `curl`/`node` against `https://accounts.spotify.com/api/token`
4. **Update the new refresh token in BOTH places**: the Pages project's `SPOTIFY_REFRESH_TOKEN` env var (dashboard) AND the Worker's secret (`wrangler secret put SPOTIFY_REFRESH_TOKEN` from `~/Sites/nltdf-mixes-refresher/`). Both must match — they were allowed to drift out of sync once during development and it caused confusion.

### Spotify Development Mode quota — still a real, recurring constraint

Even with the hourly-Worker design, **the quota can still be exhausted** — mainly by heavy manual/diagnostic testing (repeated token exchanges, repeated direct API calls during debugging) stacking on top of the Worker's own calls. Observed block durations have ranged from ~7 hours to ~20 hours in practice. When blocked:
- The Worker's manual-trigger endpoint and scheduled runs will return/log `{"error": "RATE_LIMITED"}`
- The **live site is unaffected for visitors** — it keeps serving whatever was last successfully written to `MIXES_BACKUP`
- New playlists/mixes simply won't appear until the block clears and a fetch succeeds (next hourly run, or a manual trigger once clear)
- To check current block status precisely (remaining time, not just yes/no), do a direct token exchange + `/v1/me/playlists` call and read the `Retry-After` header — see any recent conversation history for the exact `node -e` diagnostic snippet, or reconstruct: exchange refresh token for access token, call `/v1/me/playlists?limit=1`, check `res.headers.get('retry-after')` on a 429.
- **Don't run heavy diagnostic testing loops during active development** — several rounds of quota exhaustion during this project were self-inflicted by testing volume, not real visitor traffic.

## Apple Music integration

Apple Music has no public API for searching a specific account's own playlists by name (ruled out after investigation) — there's no way to auto-discover the matching Apple Music playlist URL for a given Spotify mix. The workaround: **manual name-based mapping**, stored in a KV namespace (`APPLE_MUSIC_LINKS`, id `f7b585c29c6f477f8e968cc8af590dde`). Key = exact Spotify playlist name (case-sensitive), value = the Apple Music playlist URL.

**How it's populated**: a password-protected admin page at `/admin.html`, backed by `functions/api/admin-apple-music.js`. Dan picks a mix from a live dropdown (avoids name-typo risk) and pastes the Apple Music URL. Auth is a simple shared password checked against the `ADMIN_PASSWORD` Cloudflare env var (Secret) — intentionally lightweight, fine for a single-user tool. Cloudflare Access (Zero Trust) was considered as a more robust alternative and deferred; revisit if this tool ever needs multi-person access.

**Important gotcha already hit and fixed**: the admin page's "Current Mixes" status list must NOT trust `/api/mixes`'s cached `appleMusicUrl` field for showing mapped/unmapped status — that field is only as fresh as the hourly Worker run, so a mapping just saved via the admin page wouldn't show as "Mapped" until the next hourly refresh, which looked like a broken save even though the KV write succeeded. Fixed by having `admin-apple-music.js`'s GET handler check `APPLE_MUSIC_LINKS` **live**, per mix name, instead of trusting the cached field. If this bug resurfaces (e.g. someone "simplifies" the admin endpoint back to trusting `/api/mixes`), that's the fix to reapply.

**Attaching Apple Music URLs to mixes happens in the Worker** (`nltdf-mixes-refresher/src/index.js`), inlined directly rather than importing a shared module — the Worker and the Pages project are separate deployable codebases with no shared source, so the lookup logic (~15 lines) is duplicated rather than coordinated across repos. `functions/api/_apple-music-lookup.js` in the Pages project is now dead code (was used by the old, pre-simplification `mixes.js`) — safe to delete, low priority.

## Frontend (index.html)

- Fetches `/api/mixes`, `/api/sets` (YouTube), `/api/calendar` — all server-side Functions, no client-side third-party API calls, no visitor OAuth for anything
- Mixes: grouped by month (via `oldestAddedAt` as a creation-date proxy — Spotify has no true creation-date field), sorted newest-first, "+N More" pagination pattern, each row can show both a Spotify button and (if mapped) a red Apple Music button
- Sets (YouTube) and Calendar (Google Calendar) follow the same "+N More" pagination pattern, same server-side-function architecture, both hardened against the same category of issues Spotify had (deprecated endpoints, exposed API keys) — see below
- **API keys are no longer exposed in page source** — YouTube and Google Calendar API keys were originally client-side (visible in view-source), both were rotated and moved server-side into their respective Functions (`sets.js`, `calendar.js`) during hardening
- **Play-triangle icon mobile bug (fixed)**: the "▶" character was rendering as a colorful emoji on iOS instead of inheriting CSS `color`, because WebKit auto-substitutes certain Unicode symbols with emoji presentation. Fixed by appending the invisible U+FE0E "text presentation" variation selector (`\uFE0E` in JS template literals) immediately after every "▶" in the codebase. If new "▶" usages are added, remember this.
- **Mobile grid overflow (fixed)**: `.left`/`.right` grid children needed explicit `min-width: 0` — CSS Grid/Flexbox children default to `min-width: auto`, which prevented them from shrinking below their content's intrinsic width on narrow screens, causing horizontal cutoff despite correct-looking media queries.

## Known open items / TODO

1. **Favicon** — in progress. Decided against tracing an exact letterform from the real cursive logo (attempts didn't read as legible/accurate); pivoted to an abstract neon-glow squiggle instead. Open question when resumed: the layered-glow effect (multiple stroke passes at decreasing opacity/increasing width, since SVG `<filter>`/`feGaussianBlur` doesn't render reliably via cairosvg) looks good at 512px but degrades to a mushy blob at 16px (actual browser-tab size) — needs either a tighter/thinner glow or accepting a simpler look at tiny sizes. Decide-then-build, don't re-litigate the concept from scratch.
2. **Delete dead code**: `functions/api/_apple-music-lookup.js` (Pages project, no longer imported anywhere).
3. **Mobile responsive**: done, confirmed on real device (iPhone Chrome).
4. **Apple Music links**: ongoing manual process via `/admin.html` as new mixes are created — not a "finish this" task, it's a recurring workflow.
5. Consider: does `_apple-music-lookup.js` deletion also mean the Pages project's `APPLE_MUSIC_LINKS` KV binding is now unused there too? (The Worker reads it directly now.) Check before removing the binding — `admin-apple-music.js` still needs it for the live mapping-status check.

## Debugging approach that worked

When something 403s/429s or behaves unexpectedly against a third-party API, verify directly with a `node -e` fetch snippet or `curl` before rewriting code — don't guess at fixes from symptoms alone. Multiple rounds of wasted effort across this project came from plausible-sounding theories (cache staleness, encoding issues, "maybe it's local vs remote KV") that a two-minute direct API check would have ruled in or out immediately. The `?debug=1` pattern (bypass cache, return diagnostic counts) was worth building and is worth replicating on any new integration.

**On deploys**: if a change doesn't seem to be live, check `git log --oneline` locally AND confirm what commit Cloudflare's deploy log actually built — there was a real, confusing stretch of this project where pushed commits weren't reflected in what was deployed, which turned out to be operator workflow (not realizing a push needed a follow-up action) rather than a Cloudflare bug. As of Aug 2026, auto-deploy is confirmed working — if it ever seems not to be, verify before assuming, don't just start manually triggering things.

**On file sync during earlier phases of this project**: much of this project was built via a chat interface without direct filesystem access, requiring a copy/paste or download/upload relay for every file change — a major source of "why isn't my fix showing up" confusion (stale local copies, files silently landing in the wrong directory, sandbox files going stale between conversation turns). This is no longer the workflow — Dan now edits directly in VS Code locally. If a future session somehow reverts to file-relay-style editing, be aware it's a significantly more error-prone mode and double-check file state explicitly rather than assume a described edit actually landed.
