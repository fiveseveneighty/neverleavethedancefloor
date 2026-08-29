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
// This file only ever touches 'pending' <-> 'approved' <-> 'skipped',
// plus creating brand-new 'pending' candidates (see the 'create' action
// below). 'created' is set exclusively by the Worker's cron, once the
// calendar event actually exists — never set it here, so the two writers
// can't race into double-creating the same event.
//
// POST actions:
//   approve / skip / undo   — flip an existing candidate's status.
//     Body: { password, id, action }
//   setDate                 — set/correct startDateTime (+ optional
//                              endDateTime, timeZone, note) on an existing
//                              candidate without changing its status.
//     Body: { password, id, action: 'setDate', startDateTime,
//              endDateTime?, timeZone?, note? }
//   create                  — add a brand-new 'pending' candidate (used by
//                              the daily Claude Gmail-scan job to feed the
//                              queue, same shape as the seeded candidates).
//     Body: { password, action: 'create', candidate: { title, venue,
//              city?, date?, genre?, source?, ticketUrl?, flags?, note?,
//              startDateTime?, endDateTime?, id? } }
//     Rejects with 409 DUPLICATE if an existing candidate (any status)
//     already matches on title+venue+date — mirrors the dedupe rule the
//     Claude scan is instructed to apply itself, as a second line of
//     defense against re-adding something already in the queue.

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

  const { password, id, action, startDateTime, endDateTime, timeZone, note, candidate } = body || {};

  if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) {
    return json({ error: 'UNAUTHORIZED' }, 401);
  }

  if (!env.MIXES_BACKUP) {
    return json({ error: 'MISSING_KV_BINDING' }, 500);
  }

  if (!['approve', 'skip', 'undo', 'setDate', 'create'].includes(action)) {
    return json({ error: 'BAD_REQUEST' }, 400);
  }

  if (action === 'create') {
    return handleCreate(env, candidate);
  }

  if (!id) {
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
      ...(typeof note === 'string' ? { note } : {}),
    };

    await env.MIXES_BACKUP.put(EVENT_CANDIDATES_KV_KEY, JSON.stringify(candidates));
    return json({ candidates });
  }

  const nextStatus = action === 'approve' ? 'approved' : action === 'skip' ? 'skipped' : 'pending';
  candidates[idx] = { ...candidates[idx], status: nextStatus };

  await env.MIXES_BACKUP.put(EVENT_CANDIDATES_KV_KEY, JSON.stringify(candidates));
  return json({ candidates });
}

async function handleCreate(env, candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return json({ error: 'MISSING_CANDIDATE' }, 400);
  }

  const title = (candidate.title || '').trim();
  const venue = (candidate.venue || '').trim();

  if (!title || !venue) {
    return json({ error: 'MISSING_REQUIRED_FIELDS', required: ['title', 'venue'] }, 400);
  }

  if (candidate.startDateTime && Number.isNaN(Date.parse(candidate.startDateTime))) {
    return json({ error: 'INVALID_START_DATETIME' }, 400);
  }
  if (candidate.endDateTime && Number.isNaN(Date.parse(candidate.endDateTime))) {
    return json({ error: 'INVALID_END_DATETIME' }, 400);
  }

  const candidates = await getCandidates(env);

  const norm = s => (s || '').trim().toLowerCase();
  const dupe = candidates.find(c =>
    norm(c.title) === norm(title) &&
    norm(c.venue) === norm(venue) &&
    norm(c.date) === norm(candidate.date)
  );
  if (dupe) {
    return json({ error: 'DUPLICATE', existing: dupe }, 409);
  }

  const id = (candidate.id && String(candidate.id).trim()) || `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  if (candidates.some(c => c.id === id)) {
    return json({ error: 'ID_ALREADY_EXISTS', id }, 409);
  }

  const newCandidate = {
    id,
    title,
    venue,
    city: candidate.city || '',
    date: candidate.date ?? null,
    genre: candidate.genre || '',
    source: candidate.source || '',
    ticketUrl: candidate.ticketUrl || '',
    flags: Array.isArray(candidate.flags) ? candidate.flags : [],
    note: candidate.note || '',
    status: 'pending',
    ...(candidate.startDateTime ? { startDateTime: candidate.startDateTime } : {}),
    ...(candidate.endDateTime ? { endDateTime: candidate.endDateTime } : {}),
  };

  candidates.push(newCandidate);
  await env.MIXES_BACKUP.put(EVENT_CANDIDATES_KV_KEY, JSON.stringify(candidates));

  return json({ candidates, created: newCandidate });
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
