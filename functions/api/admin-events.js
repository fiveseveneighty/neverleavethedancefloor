// functions/api/admin-events.js — Pages Function
//
// Backs the new /admin-events.html page. Mirrors admin-apple-music.js's
// pattern exactly: shared-password auth via the ADMIN_PASSWORD env var,
// reads/writes a KV key directly, no calls to any third-party API from
// here (that stays in the Worker, same separation as Spotify).
//
// KV: reuses the existing MIXES_BACKUP binding (shared with the Pages
// project's mixes.js and the nltdf-mixes-refresher Worker) under a new
// key, EVENT_CANDIDATES_KV_KEY — no new KV namespace needed.
//
// Candidate shape (matches what the daily Claude scan and the Worker's
// processApprovedEvents() both read/write):
//   { id, title, venue, city, date, genre, source, ticketUrl, flags,
//     note, status: 'pending'|'approved'|'skipped'|'created', createdAt }
//
// This file only ever touches 'pending' <-> 'approved' <-> 'skipped'.
// 'created' is set exclusively by the Worker's cron, once the calendar
// event actually exists — never set it here, so the two writers can't
// race into double-creating the same event.

const EVENT_CANDIDATES_KV_KEY = 'event-candidates';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const password = url.searchParams.get('password') || '';

  if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) {
    return json({ error: 'UNAUTHORIZED' }, 401);
  }
  if (!env.MIXES_BACKUP) {
    return json({ error: 'MISSING_KV_BINDING' }, 500);
  }

  const candidates = await getCandidates(env);
  return json({ candidates });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return json({ error: 'INVALID_JSON' }, 400);
  }

  const { password, id, action, startDateTime, endDateTime, timeZone } = body || {};
  if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) {
    return json({ error: 'UNAUTHORIZED' }, 401);
  }
  if (!env.MIXES_BACKUP) {
    return json({ error: 'MISSING_KV_BINDING' }, 500);
  }
  if (!id || !['approve', 'skip', 'undo', 'setDate'].includes(action)) {
    return json({ error: 'BAD_REQUEST' }, 400);
  }

  const candidates = await getCandidates(env);
  const idx = candidates.findIndex(c => c.id === id);
  if (idx === -1) {
    return json({ error: 'NOT_FOUND' }, 404);
  }

  // Never let the admin page move something OUT of 'created' — that would
  // let a stale page reload re-approve something the Worker already put
  // on the calendar, and processApprovedEvents() has no way to tell a
  // fresh approval from a re-approval of an already-created event.
  if (candidates[idx].status === 'created') {
    return json({ error: 'ALREADY_CREATED', candidates }, 409);
  }

  if (action === 'setDate') {
    // Manually setting/correcting the date+time on a candidate — does NOT
    // change its status (stays pending/approved), just fills in or fixes
    // the field the Worker actually needs (startDateTime) plus a matching
    // human-readable 'date' string for display, and clears the
    // 'needsDate' flag if the date was previously missing.
    if (!startDateTime || Number.isNaN(Date.parse(startDateTime))) {
      return json({ error: 'INVALID_START_DATETIME' }, 400);
    }
    if (endDateTime && Number.isNaN(Date.parse(endDateTime))) {
      return json({ error: 'INVALID_END_DATETIME' }, 400);
    }
    const displayDate = formatDisplayDate(startDateTime, timeZone);
    const nextFlags = (candidates[idx].flags || []).filter(f => f !== 'needsDate');
    candidates[idx] = {
      ...candidates[idx],
      startDateTime,
      ...(endDateTime ? { endDateTime } : {}),
      date: displayDate,
      flags: nextFlags,
    };
    await env.MIXES_BACKUP.put(EVENT_CANDIDATES_KV_KEY, JSON.stringify(candidates));
    return json({ candidates });
  }

  const nextStatus = action === 'approve' ? 'approved' : action === 'skip' ? 'skipped' : 'pending';
  candidates[idx] = { ...candidates[idx], status: nextStatus };

  await env.MIXES_BACKUP.put(EVENT_CANDIDATES_KV_KEY, JSON.stringify(candidates));
  return json({ candidates });
}

function formatDisplayDate(iso, timeZone) {
  try {
    const d = new Date(iso);
    const opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
    if (timeZone) opts.timeZone = timeZone;
    return d.toLocaleDateString('en-US', opts);
  } catch (err) {
    return iso;
  }
}

async function getCandidates(env) {
  try {
    const raw = await env.MIXES_BACKUP.get(EVENT_CANDIDATES_KV_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    return [];
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
