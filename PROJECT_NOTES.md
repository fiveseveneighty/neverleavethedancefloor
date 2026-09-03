# NLTDF Site — Project Notes

## Context

**Never Leave the Dancefloor (NLTDF)** is a Denver-based electronic music crew — a group chat of 11 friends, run by Dan. Dan maintains the group's shared Google Calendar, sends a weekly Spotify mix to the crew, and is building this site as the group's public-facing home. Dan is also actively learning to DJ (Rekordbox, working toward a Pioneer controller purchase), with a genre focus on underground electronic/techno — that's the sensibility the site should reflect, not a generic "EDM festival" vibe.

**Audience**: primarily the 11-person crew and their extended circle, with the site genuinely public-facing now — it's been shown to the crew and is live. Semi-public: real design effort matters, doesn't need enterprise polish or heavy SEO/marketing thinking. Should feel like an underground crew's page, not a startup landing page.

**Look and feel established so far**: dark, atmospheric, single-page design. Josefin Sans typeface. Background/logo as real image assets (not generated). Neon pink (`#e8789c`) as the accent color throughout — buttons, section labels, "Next up" badges. This aesthetic direction is intentional — maintain it rather than defaulting to a more generic or corporate style.

**Data conventions worth respecting**: show events always end 11:59 PM same day (never span midnight); multi-artist bills are comma-separated; Red Rocks shows are labeled "· Denver" by convention even though the venue is technically in Morrison, CO; calendar descriptions are three lines — venue, genre/vibe, ticket URL (genre line is no longer displayed on the site, but still present in the raw calendar description data).

**Dan's working style**: prefers direct, concise communication; flags confusion immediately; dislikes re-covering settled ground. High-trust, batch-review style. Now editing locally in VS Code (`code .` from the repo root) rather than the upload/download file-relay workflow used earlier in the project — commits and pushes directly from VS Code's integrated terminal.

**Deploys are automatic** on push to `main` (confirmed working as of Aug 2026 — earlier in the project there was real, prolonged confusion about whether Cloudflare Pages was auto-deploying or not; it is, and no manual "Retry deployment" step is needed).

**Correction (Aug 30 2026): the "no outbound network access" claim below was wrong** — both the cloud sandbox and the device shell on Dan's Mac (`device_bash`) have real, working outbound network access, confirmed directly via `curl` from both to `neverleavethedancefloor.com`, `github.com`, and the `nltdf-mixes-refresher` Worker's `workers.dev` endpoint. A Cowork session **can** run `curl`, `wrangler kv key get`, `wrangler tail`, and similar network-dependent diagnostics itself. What actually blocked things earlier was narrower and specific: the cloud sandbox's *git push* path goes through a proxy with its own session-level repo-authorization allowlist, which rejected pushes to `neverleavethedancefloor` specifically — that's a git-push-only restriction, not a general network block, and it was worked around with a repo-scoped SSH deploy key pushed from the device shell instead (see `claude/EVENT_SOURCES.md`'s "Pushing changes to this repo" section for the exact mechanism — the same pattern applies to any repo under `~/Sites` that needs it). `wrangler deploy` for `nltdf-mixes-refresher` has not been specifically re-tested from either sandbox since this correction — treat it as likely to work given the general network access is confirmed, but verify before assuming if it matters. A Cowork session still has no delete permission on Dan's connected folders by default — files that need removing get moved to a `_to_delete/` subfolder instead, with the actual `git rm`/`rm -rf` command handed to Dan to run (or `device_request_delete_permission` can be tried, though it may be declined automatically for a broad folder — see the git-lock workaround in `claude/EVENT_SOURCES.md` for a case where that happened).

**Update (Aug 28 2026): the built-in Claude Browser (desktop app browser pane) also has real internet access**, independently of the above — it was used successfully to hit the `nltdf-mixes-refresher` Worker's manual-trigger endpoint (`https://nltdf-mixes-refresher.dansaltzmandesign.workers.dev/`) and to check `/api/mixes` and the live homepage. Useful as a read-only fallback when a shell isn't handy.

---

## Architecture (current, as of Aug 2026)

- **Hosting**: Cloudflare Pages, auto-deploys on push to `main`
- **Live URLs**: `neverleavethedancefloor.com` and `neverleavethedancefloor.pages.dev` (same Production deployment)
- **Repo**: `github.com/fiveseveneighty/neverleavethedancefloor`, local at `~/Sites/neverleavethedancefloor/`
- **Frontend**: single `index.html`, vanilla JS, no build step
- **Backend**: Cloudflare Pages Functions in `functions/api/`
- **A second, separate deployable project**: `nltdf-mixes-refresher`, a standalone Cloudflare Worker (own folder at `~/Sites/nltdf-mixes-refresher/`, own `wrangler.jsonc`, deployed via `wrangler deploy`, NOT part of the Pages project). **Not currently under git** (no `.git` in that folder, unlike the main Pages repo) — worth noting if this ever needs rollback/history. See "Spotify mixes architecture" below for why this exists.

## Spotify mixes architecture — READ THIS BEFORE TOUCHING mixes.js

**This changed significantly partway through the project. The old design (Pages Function calls Spotify live on every cache-miss) is gone. Do not reintroduce it.**

### Why it changed

The original design had `functions/api/mixes.js` call Spotify directly whenever Cloudflare's edge cache expired (originally 10 min, later bumped to 30 min). This meant Spotify API call volume scaled with **visitor traffic** — the more people loaded the site, the more Spotify calls happened. Spotify's Developer Dashboard shows this app is in **Development Mode**, which has a real, recurring quota ceiling (not a one-time testing artifact). This caused repeated `429 QUOTA_EXCEEDED` blocks, including **on the crew's actual launch day**, where real visitors got "Couldn't load mixes" errors.

Extended/production quota mode was investigated and ruled out — as of Spotify's policy at time of investigation, it requires an organization account, not viable for this personal project.

### Current design

1. **`nltdf-mixes-refresher`** (standalone Worker, separate deploy) — runs on an **hourly Cron Trigger** (`0 * * * *` in its `wrangler.jsonc`). Fetches fresh data from Spotify (owned/public-filtering logic, plus snapshot-based caching — see below), attaches Apple Music URLs, and writes the result to a KV namespace called `MIXES_BACKUP` (key: `mixes-backup`, value: `{ mixes: [...], savedAt }`).
2. **`functions/api/mixes.js`** (Pages Function) — extremely simple. **Never calls Spotify.** Just reads `MIXES_BACKUP` from KV and returns it. Confirmed clean (re-verified Aug 2026 while debugging a quota question) — this file cannot be a source of Spotify calls.
3. **`functions/api/admin-apple-music.js`** — also confirmed clean. Reads `/api/mixes` (which reads KV) and the `APPLE_MUSIC_LINKS` KV directly; never touches Spotify.
4. Visitor traffic **cannot** trigger a Spotify call, no matter how much of it there is.

### Why Pages Functions couldn't do this directly

Cloudflare Cron Triggers are a **Workers-only** feature — confirmed via Cloudflare's own "Migrate from Pages to Workers" docs, which lists Cron Triggers as something you gain by leaving Pages. Pages Functions do not support scheduled/cron execution. This is why a second, separate Worker project exists instead of just adding a cron config to the Pages project.

### Setup for `nltdf-mixes-refresher`

- Directory: `~/Sites/nltdf-mixes-refresher/` (`wrangler.jsonc` at root, code in `src/index.js`)
- KV bindings (in `wrangler.jsonc`): `MIXES_BACKUP` (id `08152069502b4458a63dbaeb99863a79`), `APPLE_MUSIC_LINKS` (id `f7b585c29c6f477f8e968cc8af590dde`)
- Secrets (set via `wrangler secret put NAME`, NOT Cloudflare dashboard env vars — this is a Worker, not Pages): `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`, and now optionally `RESEND_API_KEY` (see "Email alerts" below)
- Plain (non-secret) vars in `wrangler.jsonc`: `ALERT_EMAIL_TO`, `ALERT_EMAIL_FROM` (see "Email alerts" below)
- Also exposes an HTTP `fetch` handler (same logic as `scheduled`) at `https://nltdf-mixes-refresher.dansaltzmandesign.workers.dev/` for manual on-demand triggering — useful for testing or forcing an immediate refresh without waiting for the next hourly run, and safe to hit anytime for a status check since it no longer blindly calls Spotify (see backoff below). No auth on this endpoint; not linked from the main site, low-risk personal-tool exposure.
- **The `fetch` handler short-circuits `/favicon.ico` and `/robots.txt` with a bare 204** before calling `refreshMixes` (fixed Aug 23 2026). Found via `wrangler tail`: a single browser visit to the root URL was generating two full log entries — `/` and `/favicon.ico` — because browsers auto-request a tab icon, and without the short-circuit that second request triggered a second full refresh (redundant Spotify/cache work, and a second shot at tripping quota, from one visit). Verified locally (`test-favicon.mjs`): hitting `/` triggers exactly 1 refresh call, hitting `/favicon.ico` or `/robots.txt` triggers 0.
- To redeploy after code changes: `cd ~/Sites/nltdf-mixes-refresher && wrangler deploy`

### Stale-data fallback (still present, secondary safety net)

`mixes.js` cannot fail on Spotify's end (it never calls Spotify). If `MIXES_BACKUP` is empty (e.g. very first deploy before the Worker has ever run), it returns `{ mixes: [], generatedAt: null }` rather than erroring.

### Refresh token lifecycle

Spotify refresh tokens have a **180-day lifetime** (per the Spotify Developer Dashboard's "Basic Information" page). If it ever needs regenerating (expired, revoked, password change), redo the one-time Authorization Code flow as `fiveseveneighty`:
1. Visit `https://accounts.spotify.com/authorize?response_type=code&client_id=06532c6d580f458aba98f41fdf71f344&scope=playlist-read-private%20playlist-read-collaborative&redirect_uri=https%3A%2F%2Fneverleavethedancefloor.com` (redirect URI must exactly match one registered in the Spotify app's dashboard — currently `https://neverleavethedancefloor.com` with NO trailing slash, and `https://neverleavethedancefloor.pages.dev/` WITH one — these are registered as distinct, exact strings)
2. Log in as fiveseveneighty, approve, copy the `code` param from the redirect URL (single-use, expires in minutes)
3. Exchange it for tokens via `curl`/`node` against `https://accounts.spotify.com/api/token`
4. **Update the new refresh token in BOTH places**: the Pages project's `SPOTIFY_REFRESH_TOKEN` env var (dashboard) AND the Worker's secret (`wrangler secret put SPOTIFY_REFRESH_TOKEN` from `~/Sites/nltdf-mixes-refresher/`). Both must match — they were allowed to drift out of sync once during development and it caused confusion.
5. Since Aug 2026, letting this expire/get revoked without noticing is covered by the general-error email alert (see "Part 4" below) — you should get an email saying the refresh is broken, likely mentioning TOKEN in the error, within an hour of it happening.

### Spotify Development Mode quota — still a real, recurring constraint

**A recurring, expected thing.** If `/api/mixes` or the refresher Worker ever shows a rate-limit condition, that's normal operation for a Development Mode app, not a bug to chase — check the actual retry timing rather than assuming something broke.

**Part 1 — backoff (root cause found + fixed + deployed, Aug 23 2026):** Dan noticed the site was still rate-limited despite no manual testing in the prior 24 hours. Investigating `nltdf-mixes-refresher/src/index.js` found the real likely cause wasn't manual testing at all — it was the automation itself: the hourly cron had **no backoff**, retrying the full sequence every hour even immediately after a 429, and it discarded the `Retry-After` header entirely, so there was no record of how long any block actually was or whether hourly retries were extending it. If Spotify's quota is a rolling window, hourly retries with no backoff could plausibly keep re-triggering the block indefinitely — exactly matching "we've done nothing in 24h but we're still blocked."

The fix: every Spotify-domain request now goes through a `spotifyFetch()` wrapper that captures the real `Retry-After` header on a 429 and throws a typed `SpotifyRateLimitError` (value + which call: `token`/`playlists`/`playlist_detail`). On that error, a `spotify-rate-limit-status` key is written to `MIXES_BACKUP` KV (`{ blockedUntil, retryAfterSeconds, retryAfterWasEstimated, detectedAt, source }`; falls back to a 1-hour estimate only if Spotify sends no header). **Every run checks this key first and makes zero Spotify calls if still inside the window.** A successful run clears it.

**Confirmed live, Aug 23 2026:** first post-deploy hit returned a real `retryAfterSeconds: 6030` on the `playlists` call (`retryAfterWasEstimated: false`), proving the header capture works. After that window passed, a manual trigger returned a full clean success: `totalPlaylists: 114, ownedPlaylists: 88, publicPlaylists: 53, mixesCount: 46, fetchErrorCount: 7`. Block cleared on its own after the backoff window — no immediate re-trigger.

**Part 2 — snapshot-based caching (built + tested + deployed, Aug 23 2026):** the numbers above surfaced a second, more fundamental problem — **53 public playlists** means every hourly run was making a Spotify detail call *per playlist* (~55 calls/run counting token+list, ~1,300+/day), regardless of whether anything had actually changed. The backoff fix stops the Worker from hammering an *active* block, but doesn't reduce this baseline volume, which is plausibly high enough to trigger blocks fairly routinely even under normal operation.

The fix: Spotify playlist objects carry a `snapshot_id` that only changes when the playlist's tracks change. Each playlist's computed stats (track count, total duration, newest/oldest added date) are now cached in KV under `playlist-stats-cache`, keyed by playlist ID with the `snapshot_id` they were computed from. On each run, a playlist whose current `snapshot_id` matches the cached one is served entirely from cache — **zero Spotify calls for it**. Only playlists that actually changed since the last successful run cost a real call.

**Confirmed live, Aug 23 2026:** first run after deploy (cold cache) showed `cacheHits: 0, cacheMisses: 53` — expected, cache was empty. The very next run showed `cacheHits: 53, cacheMisses: 0, fetchErrorCount: 0` — full cache coverage, zero Spotify detail calls made, just the token exchange + playlist list (~2 calls instead of ~55). The `fetchErrorCount` dropping from 7 (on the cold-cache run) to 0 once cached suggests those 7 were transient hiccups from the burst of near-simultaneous requests during a full re-fetch, not a persistent problem with those specific playlists — and now that they're cached, they won't need to be re-fetched (so won't get another chance to transiently fail) until actually edited.

Implementation notes worth knowing if this needs touching again:
- The cache is pruned each run to only playlists currently in the public/owned set, so removed/unpublicized playlists don't accumulate forever.
- If a 429 hits partway through a batch of detail calls, playlists already fetched successfully in that batch still get their cache updated (verified via test) — partial progress isn't lost, so the next run has fewer playlists left to fetch, not the same 53 again.
- A non-rate-limit fetch error on a single playlist (network blip, etc.) now falls back to that playlist's last-known cached stats (flagged `statsStale: true`) rather than dropping the mix from the site entirely.
- Rebuilt `trackCount` from the fetched entries directly (rather than a `playlist.items?.total` field that doesn't actually exist on Spotify's playlist object — it's `tracks.total` — so that field was always silently falling through to the `entries.length` fallback anyway) — no behavior change, just no-longer-dead code.
- Known pre-existing limitation, unrelated to this fix and not changed: the per-playlist items request is unpaginated (`limit=100`), so a playlist with more than 100 tracks would have its stats computed from only the first 100. None of the current mixes are near that size.

**Part 3 — email alerts on block start/clear (built + tested + deployed, Aug 23 2026):** Dan asked to be personally notified when the site falls back to cached data, since he can't do anything about a block right away and wanted a passive heads-up rather than a phone push. Sent via **Resend's HTTP API** (plain `fetch`, no SDK — kept this a zero-dependency single-file Worker).

- Gated on a `RESEND_API_KEY` secret. **Dan still needs to**: sign up at resend.com, generate an API key, then `wrangler secret put RESEND_API_KEY` from `~/Sites/nltdf-mixes-refresher/`, then `wrangler deploy`. Until that secret is set, alerts are silently skipped (logged only) — the refresh logic itself never depends on this working.
- Sender defaults to `onboarding@resend.dev` (Resend's no-verification-needed shared sender) — fine to start, swap for a verified `@neverleavethedancefloor.com` address later if desired (would need adding that domain in Resend and its DNS records in Cloudflare).
- Recipient/sender addresses are `ALERT_EMAIL_TO` / `ALERT_EMAIL_FROM` plain vars in `wrangler.jsonc` (not secrets — easy to change without touching code). Currently `ALERT_EMAIL_TO` defaults to Dan's account email.
- **Fires at exactly two moments**, not every hourly check: when a block *starts* (a live Spotify call just 429'd and there was no active backoff before this run) and when a block *clears* (a run succeeds and there was a real rate-limit status to clear). A routine successful hourly run with nothing to report sends nothing. Verified via mocked test: routine success → 0 emails; new 429 → exactly 1 "blocked" email; still-backed-off hours → no additional email; recovery → exactly 1 "back to live" email; another routine success after that → still no 3rd email.
- Never blocks or breaks the actual refresh — `sendAlertEmail()` catches its own errors and just logs, whether that's a missing key, Resend being down, or a network blip.

**Part 4 — email alerts on non-quota failures too (built + tested + deployed, Aug 23 2026):** follow-up to Part 3 — a genuinely broken refresh (expired/revoked Spotify refresh token, a removed KV binding, an actual bug) does NOT self-resolve the way a quota block does, so Dan asked for this to alert too, not just quota blocks.

- `refreshMixes()`'s guard clauses (`MISSING_CREDENTIALS`, `MISSING_KV_BINDING`) and its whole body are now inside one try/catch, so literally any failure gets a chance to alert before propagating — not just `SpotifyRateLimitError`.
- De-duped via a `spotify-general-error-status` KV key (`{ errorMessage, firstSeenAt, lastSeenAt, lastAlertedAt }`), separate from the rate-limit status key: alerts immediately the first time an error is seen, then at most once per **12 hours** while the *same* error message persists (`GENERAL_ERROR_REALERT_SECONDS`), so a stuck broken-token situation gets you a periodic reminder rather than either silence or an email every single hour. A *different* error message always re-alerts immediately regardless of timing.
- Clears (and sends a "working again" email) the next time a run actually succeeds — mirrors the block-clear pattern from Part 3.
- Edge case: if `env.MIXES_BACKUP` itself is the thing that's missing, there's no KV to de-dupe against — falls back to alerting every time in that one specific scenario rather than going silent (rare: only happens if the KV binding itself gets removed from the Worker config).
- Verified via mocked test (`test-general-error.mjs`): first failure → 1 email; identical error again within 12h → no 2nd email; same error after simulating 12h passing → 2nd email sent; fixed → exactly 1 "working again" email; another routine success after that → no further email.
- Subject lines to recognize: `"NLTDF: mixes refresh broken — needs attention"` and `"NLTDF: mixes refresh working again"`, distinct from the Part 3 quota-block subjects (`"...blocked — site on cached data"` / `"...back to live..."`) so the two situations aren't confused when skimming an inbox.

**Still true / unchanged:**
- The **live site is unaffected for visitors** during a block — it keeps serving whatever was last successfully written to `MIXES_BACKUP`.
- New playlists/mixes simply won't appear until the block clears and a fetch succeeds.
- Heavy manual/diagnostic testing (repeated token exchanges, repeated direct API calls while debugging) can still trigger or extend a block on its own — keep being sparing with direct diagnostic calls during active development.

## Apple Music integration

Apple Music has no public API for searching a specific account's own playlists by name (ruled out after investigation) — there's no way to auto-discover the matching Apple Music playlist URL for a given Spotify mix. The workaround: **manual name-based mapping**, stored in a KV namespace (`APPLE_MUSIC_LINKS`, id `f7b585c29c6f477f8e968cc8af590dde`). Key = exact Spotify playlist name (case-sensitive), value = the Apple Music playlist URL.

**How it's populated**: a password-protected admin page at `/admin.html`, backed by `functions/api/admin-apple-music.js`. Dan picks a mix from a live dropdown (avoids name-typo risk) and pastes the Apple Music URL. Auth is a simple shared password checked against the `ADMIN_PASSWORD` Cloudflare env var (Secret) — intentionally lightweight, fine for a single-user tool. Cloudflare Access (Zero Trust) was considered as a more robust alternative and deferred; revisit if this tool ever needs multi-person access.

**Important gotcha already hit and fixed**: the admin page's "Current Mixes" status list must NOT trust `/api/mixes`'s cached `appleMusicUrl` field for showing mapped/unmapped status — that field is only as fresh as the hourly Worker run, so a mapping just saved via the admin page wouldn't show as "Mapped" until the next hourly refresh, which looked like a broken save even though the KV write succeeded. Fixed by having `admin-apple-music.js`'s GET handler check `APPLE_MUSIC_LINKS` **live**, per mix name, instead of trusting the cached field. If this bug resurfaces (e.g. someone "simplifies" the admin endpoint back to trusting `/api/mixes`), that's the fix to reapply.

**Attaching Apple Music URLs to mixes happens in the Worker** (`nltdf-mixes-refresher/src/index.js`), inlined directly rather than importing a shared module — the Worker and the Pages project are separate deployable codebases with no shared source, so the lookup logic (~15 lines) is duplicated rather than coordinated across repos. The old standalone helper, `functions/api/_apple-music-lookup.js`, was dead code (used only by the pre-refactor `mixes.js`, which called Spotify directly and needed to attach Apple Music links itself) — verified via repo-wide grep that nothing imported it, then removed (Aug 2026).

**Admin page favicon (added Aug 24 2026)**: `/admin.html` now has its own distinct favicon, separate from the main site's, so the two tabs are easy to tell apart at a glance while both are open. Source art is `Favico-for-admin.png` (hot-pink/white cursive "N" on a transparent background, supplied by Dan, at repo root). Files: `admin-favicon-16x16.png`, `admin-favicon-32x32.png`, `admin-favicon.ico` (16/32/48 multi-size), `admin-apple-touch-icon.png` (180x180), all at repo root, linked from `admin.html`'s `<head>`. Build note: a naive Lanczos downsample of the cursive artwork went mushy at 16px (same problem the main favicon hit before hand-tuning) — fixed by cropping tightly to the glyph's bounding box (the source had extra transparent padding) and slightly dilating the alpha channel (thickening the stroke) before downsizing, which keeps the shape legible at 32px and at least clearly a distinct pink mark (vs. the main site's white one) at 16px. Reviewed with Dan via a tab-mockup comparison image before deploying.

**Idea to discuss (raised Aug 28 2026, not yet scoped): an "automatic push" button on the admin page.** Dan wants to talk through adding a button there that would trigger a refresh immediately after saving an Apple Music link, instead of the link only showing on the live site once the next hourly cron run happens (today he/Cowork can force this manually by hitting the `nltdf-mixes-refresher` Worker's fetch endpoint — see above — but there's no in-admin-UI way to do that yet). Worth discussing: probably just an admin-page button that calls the Worker's manual-trigger URL and shows the result inline.

## Frontend (index.html)

- Fetches `/api/mixes`, `/api/sets` (YouTube), `/api/calendar` — all server-side Functions, no client-side third-party API calls, no visitor OAuth for anything
- Mixes: grouped by month (via `oldestAddedAt` as a creation-date proxy — Spotify has no true creation-date field), sorted newest-first, "+N More" pagination pattern, each row can show both a Spotify button and (if mapped) a red Apple Music button
- Sets (YouTube) and Calendar (Google Calendar) follow the same "+N More" pagination pattern, same server-side-function architecture, both hardened against the same category of issues Spotify had (deprecated endpoints, exposed API keys) — see below
- **API keys are no longer exposed in page source** — YouTube and Google Calendar API keys were originally client-side (visible in view-source), both were rotated and moved server-side into their respective Functions (`sets.js`, `calendar.js`) during hardening
- **Play-triangle icon mobile bug (fixed)**: the "▶" character was rendering as a colorful emoji on iOS instead of inheriting CSS `color`, because WebKit auto-substitutes certain Unicode symbols with emoji presentation. Fixed by appending the invisible U+FE0E "text presentation" variation selector (`︎` in JS template literals) immediately after every "▶" in the codebase. If new "▶" usages are added, remember this.
- **Mobile grid overflow (fixed)**: `.left`/`.right` grid children needed explicit `min-width: 0` — CSS Grid/Flexbox children default to `min-width: auto`, which prevented them from shrinking below their content's intrinsic width on narrow screens, causing horizontal cutoff despite correct-looking media queries.
- **Favicon (added Aug 2026)**: `<head>` now links `favicon-32x32.png`, `favicon-16x16.png`, `favicon.ico` (multi-size, 16/32/48), and `apple-touch-icon.png` (180x180), all at repo root. Final design is a white neon "N" mark on a near-black background (`rgb(2,1,2)`, close to the site's own `#060408` body background) — source files live in `NLTDF-white-neon-n-favicon-package/` at repo root (16/32/48/64px hand-tuned renders plus a 1254px master). The 16/32/48 sizes used in `favicon.ico` are the hand-tuned per-size renders, not resampled from the master, to preserve legibility at small sizes (this was the open problem noted below before Dan resolved it — the glow reads clean at 16px, not mushy). `apple-touch-icon.png` is a Lanczos resize from the 1254px master since no hand-tuned 180px version exists.
- **`admin.html` has its own separate favicon** — see "Admin page favicon" under "Apple Music integration" above.

## Known open items / TODO

1. ~~**Favicon**~~ — done, deployed Aug 2026. See "Favicon" note above.
2. ~~**Delete dead code**: `functions/api/_apple-music-lookup.js`~~ — done, removed and confirmed by Dan Aug 2026.
3. **Mobile responsive**: done, confirmed on real device (iPhone Chrome).
4. **Apple Music links**: ongoing manual process via `/admin.html` as new mixes are created — not a "finish this" task, it's a recurring workflow.
5. ~~Consider: does `_apple-music-lookup.js` deletion mean the Pages project's `APPLE_MUSIC_LINKS` KV binding is now unused there too?~~ — resolved: no, `admin-apple-music.js` still reads it directly for the live mapping-status check. Binding stays.
6. ~~**Spotify rate-limit backoff fix**~~ — done, deployed and confirmed clearing a real block cleanly (see "Spotify Development Mode quota" above).
7. **Spotify snapshot-based caching** — done, deployed and confirmed full cache coverage (0 Spotify calls on a quiet run). Worth revisiting after a week or two: has quota exhaustion become noticeably rarer now that quiet hours cost ~2 Spotify calls instead of ~55?
8. **Email alerts on block start/clear** — code deployed, Dan confirmed he set the `RESEND_API_KEY` secret and redeployed ("ok done", Aug 23 2026) — alerts should be live, not yet confirmed by an actual alert firing for real.
9. ~~**Alert on non-quota failures**~~ — done, deployed (see "Part 4" above). Also gated on the same `RESEND_API_KEY` secret as item 8.
10. ~~**Duplicate refresh on favicon.ico request**~~ — done, deployed Aug 23 2026. See the short-circuit note under "Setup for `nltdf-mixes-refresher`" above.
11. ~~**Admin page favicon**~~ — done, deployed Aug 24 2026. See "Admin page favicon" above.
12. **Admin page "automatic push" button** — to discuss next time (raised Aug 28 2026). Add a button to `/admin.html` that triggers an immediate mixes refresh (hitting the `nltdf-mixes-refresher` Worker's manual endpoint) right after saving an Apple Music link, so new links show up on the live site without waiting for the next hourly cron. Not yet scoped — needs a decision on UI (separate button vs. auto-fire on save) and whether/how to surface the refresh result (success/error) in the admin UI.

## Debugging approach that worked

When something 403s/429s or behaves unexpectedly against a third-party API, verify directly with a `node -e` fetch snippet or `curl` before rewriting code — don't guess at fixes from symptoms alone. Multiple rounds of wasted effort across this project came from plausible-sounding theories (cache staleness, encoding issues, "maybe it's local vs remote KV") that a two-minute direct API check would have ruled in or out immediately. The `?debug=1` pattern (bypass cache, return diagnostic counts) was worth building and is worth replicating on any new integration. A Cowork session's own shell/sandbox (and the device shell) can run these direct checks itself — see the network-access correction at the top of this doc — and the built-in Claude Browser is also a real option for read-only checks and manual-trigger endpoints. A `test.mjs` / `test-email.mjs` / `test-general-error.mjs` pattern was used for the caching fix and both email-alert fixes, and is worth reusing for future changes to this file.

**On deploys**: if a change doesn't seem to be live, check `git log --oneline` locally AND confirm what commit Cloudflare's deploy log actually built — there was a real, confusing stretch of this project where pushed commits weren't reflected in what was deployed, which turned out to be operator workflow (not realizing a push needed a follow-up action) rather than a Cloudflare bug. As of Aug 2026, auto-deploy is confirmed working for the Pages project — if it ever seems not to be, verify before assuming, don't just start manually triggering things. Note the `nltdf-mixes-refresher` Worker does NOT have auto-deploy — it's not even under git — so a code change there always needs an explicit `wrangler deploy` to go live.

**On file sync during earlier phases of this project**: much of this project was built via a chat interface without direct filesystem access, requiring a copy/paste or download/upload relay for every file change — a major source of "why isn't my fix showing up" confusion (stale local copies, files silently landing in the wrong directory, sandbox files going stale between conversation turns). This is no longer the workflow — Dan now edits directly in VS Code locally. If a future session somehow reverts to file-relay-style editing, be aware it's a significantly more error-prone mode and double-check file state explicitly rather than assume a described edit actually landed.
