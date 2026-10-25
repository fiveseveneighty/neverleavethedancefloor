/* NLTDF set sequencer engine (B-37). Pure functions, no DOM and no network:
 * library.html's Sequencing panel (build step 3) calls it with tracks it
 * already has. Design and the numbers behind the weights: claude/SET_SEQUENCER.md.
 *
 * A track here is { id, camelot, bpm, energy } (extra fields are ignored).
 * Exposed as window.NLTDFSequencer (and module.exports for Node tests).
 */
(function (root) {
  'use strict';

  // ── Camelot tiers: same table as COMPAT_TABLE in library.html, generated ──
  const TIERS = ['pm', 'b1', 'b2', 'b3', 'd1', 'd2', 'd3', 'mood'];
  const CT = {};
  for (let n = 1; n <= 12; n++) for (const L of ['A', 'B']) {
    const k = n + L, w = x => ((n - 1 + x + 120) % 12) + 1;
    CT[k] = L === 'A'
      ? { pm: [k, w(-1) + 'B'], b1: [n + 'B', w(1) + 'A'], b2: [w(9) + 'A'], b3: [w(2) + 'A', w(7) + 'A'], d1: [w(-1) + 'A'], d2: [w(3) + 'A'], d3: [w(-2) + 'A', w(5) + 'A'], mood: [w(3) + 'B'] }
      : { pm: [k, w(1) + 'A'], b1: [w(1) + 'B'], b2: [w(9) + 'B'], b3: [w(2) + 'B', w(7) + 'B'], d1: [n + 'A', w(-1) + 'B'], d2: [w(3) + 'B'], d3: [w(-2) + 'B', w(5) + 'B'], mood: [w(9) + 'A'] };
  }
  function tier(a, b) {
    if (a === b) return 'same';
    const c = CT[a] || {};
    for (const t of TIERS) if ((c[t] || []).includes(b)) return t;
    return 'other';
  }

  // ── Weights (scramble test, Oct 24 2026 MT: keys weighted 1.6x; everything else as drafted) ──
  const KEY_COST = { same: 0, pm: .05, d1: .1, b1: .15, mood: .3, b3: .45, d3: .45, b2: .6, d2: .6, other: 1 };
  const W = { key: 1.6, bpm: 1, shape: 1.2, energyTol: .06, bpmTol: 4, beam: 20, weak: .9 * 1.6 };
  const SHAPES = { lg: 'Locked groove', cl: 'Climb', rr: 'Ride and release', so: 'Strong open, ease out', mo: 'Match my opening', sp: 'Spotify current' };

  const bpmDist = (a, b) => Math.min(Math.abs(b - a), Math.abs(2 * b - a) + 1, Math.abs(b - 2 * a) + 1); // half/double time counts as close
  const bpmCost = d => d <= 2 ? 0 : d <= 4 ? (d - 2) * .05 : d <= 8 ? .1 + (d - 4) * .08 : Math.min(1.2, .42 + (d - 8) * .06);

  // ctx: { shape, pulse, prof } — prof only for 'mo' (see profile())
  function keyCost(t, ctx) {
    // Key habits: from the locked opening (Match my opening) or from the template sets (Fill "Like")
    const tiers = ctx.tpl ? ctx.tpl.tiers : (ctx.shape === 'mo' && ctx.prof ? ctx.prof.tiers : null);
    if (!tiers) return KEY_COST[t];
    const f = tiers[t] || 0;
    return t === 'other' ? Math.max(.25, 1 - 1.5 * f) : KEY_COST[t] * (f ? .5 : 1);
  }
  function transitionCost(a, b, ctx) {
    return W.key * keyCost(tier(a.camelot, b.camelot), ctx) + W.bpm * bpmCost(bpmDist(a.bpm, b.bpm));
  }
  // Pulse: reward energy that alternates; penalise two steps the same way or a flat step
  function pulseCost(a, b, c, ctx) {
    if (!a) return 0;
    // With a template, a third track in the same key is penalised: same-key moves cost nothing on
    // their own, and without this a fill locks onto one key (Dan's sets use same key ~11% of the time)
    const run = ctx.tpl && a.camelot === b.camelot && b.camelot === c.camelot ? .6 : 0;
    if (!ctx.pulse) return run;
    const d1 = b.energy - a.energy, d2 = c.energy - b.energy;
    return run + (d1 * d2 > 0 ? .25 : 0) + (Math.abs(d2) < .08 ? .1 : 0);
  }
  // [targetEnergy, targetBpm] at position p (0..1) for a set of n tracks opening on o
  function target(p, n, o, ctx) {
    const e0 = o.energy, b0 = o.bpm;
    if (ctx.tpl) return [tplAt(ctx.tpl.energy, p), b0 + tplAt(ctx.tpl.bpmDrift, p)];
    switch (ctx.shape) {
      case 'cl': return [e0 + (Math.min(1, e0 + .3) - e0) * p, b0 + 10 * p];
      case 'rr': { const waves = Math.max(1, Math.round(n / 12)); return [.72 + .16 * Math.cos(2 * Math.PI * waves * p), b0 - 5 * p]; }
      case 'so': return [e0 - .25 * p, b0 - 3 * p];
      case 'mo': if (ctx.prof) return [ctx.prof.energy, ctx.prof.bpm]; // falls through without a profile
      default: return [(e0 + .8) / 2, b0]; // 'lg'
    }
  }
  const energyTol = ctx => ctx.tpl ? ctx.tpl.energyTol : ctx.shape === 'mo' && ctx.prof ? ctx.prof.energySd : W.energyTol;
  const bpmTol = ctx => ctx.tpl ? ctx.tpl.bpmTol : ctx.shape === 'mo' && ctx.prof ? ctx.prof.bpmSpread : W.bpmTol;
  function shapeCost(x, pos, n, o, ctx) {
    const p = n > 1 ? pos / (n - 1) : 0, [te, tb] = target(p, n, o, ctx);
    const e = Math.max(0, Math.abs(x.energy - te) - energyTol(ctx)) * 2.5;
    const b = ctx.shape === 'lg' && !ctx.tpl ? 0 : Math.max(0, Math.abs(x.bpm - tb) - bpmTol(ctx)) / 8 * .6;
    return W.shape * (e + b);
  }
  function totalCost(seq, ctx) {
    let c = 0;
    for (let i = 0; i < seq.length; i++) {
      c += shapeCost(seq[i], i, seq.length, seq[0], ctx);
      if (i) c += transitionCost(seq[i - 1], seq[i], ctx);
      if (i > 1) c += pulseCost(seq[i - 2], seq[i - 1], seq[i], ctx);
    }
    return c;
  }

  // "Match my opening": stats of the opener plus the locked tracks directly under it (needs 3+)
  function profile(opening) {
    if (!opening || opening.length < 3) return null;
    const e = opening.map(x => x.energy), b = opening.map(x => x.bpm).sort((p, q) => p - q);
    const mean = e.reduce((p, q) => p + q, 0) / e.length;
    const sd = Math.sqrt(e.reduce((p, q) => p + (q - mean) ** 2, 0) / e.length);
    const tiers = {};
    for (let i = 1; i < opening.length; i++) { const t = tier(opening[i - 1].camelot, opening[i].camelot); tiers[t] = (tiers[t] || 0) + 1 / (opening.length - 1); }
    let turns = 0;
    for (let i = 1; i < e.length - 1; i++) if ((e[i] - e[i - 1]) * (e[i + 1] - e[i]) < 0) turns++;
    return { count: opening.length, energy: mean, energySd: Math.max(.05, sd), bpm: b[Math.floor(b.length / 2)], bpmSpread: Math.max(3, (b[b.length - 1] - b[0]) / 2), tiers, turnRate: turns / Math.max(1, e.length - 2) };
  }

  /* Order tracks. opts:
   *   tracks: all tracks in the set (any order), each with id/camelot/bpm/energy
   *   openerId: the first track
   *   shape: 'lg' | 'cl' | 'rr' | 'so' | 'mo'
   *   pulse: boolean
   *   lockedAt: { position: trackId } — tracks that must stay where they are
   * Returns { order: [trackId…], prof } — prof is the opening profile used for 'mo' (or null).
   * Tracks without camelot/bpm/energy can't be scored; callers keep them out (or locked). */
  function sequence(opts) {
    const byId = new Map(opts.tracks.map(t => [t.id, t]));
    const n = opts.tracks.length, o = byId.get(opts.openerId), lockedAt = opts.lockedAt || {};
    let prof = null;
    if (opts.shape === 'mo') {
      const opening = [o];
      for (let k = 1; lockedAt[k]; k++) opening.push(byId.get(lockedAt[k]));
      prof = profile(opening);
    }
    const ctx = { shape: opts.shape, pulse: !!opts.pulse, prof, tpl: opts.tpl || null };
    const lockedIds = new Set(Object.values(lockedAt));
    let beams = [{ s: [o], c: 0 }];
    for (let pos = 1; pos < n; pos++) {
      const next = [];
      for (const bm of beams) {
        const used = new Set(bm.s.map(x => x.id)), last = bm.s[bm.s.length - 1], prev = bm.s.length > 1 ? bm.s[bm.s.length - 2] : null;
        const fixed = lockedAt[pos];
        const cands = fixed && !used.has(fixed) ? [byId.get(fixed)] : opts.tracks.filter(x => !used.has(x.id) && !lockedIds.has(x.id) && x.id !== o.id);
        for (const x of cands) next.push({ s: bm.s.concat(x), c: bm.c + transitionCost(last, x, ctx) + pulseCost(prev, last, x, ctx) + shapeCost(x, pos, n, o, ctx) });
      }
      next.sort((a, b) => a.c - b.c);
      beams = next.slice(0, W.beam);
    }
    // Clean-up: swap pairs of unlocked tracks while that lowers the total
    let best = beams[0].s, bestCost = totalCost(best, ctx);
    const pinned = new Set([o.id, ...lockedIds]);
    for (let pass = 0; pass < 2; pass++) for (let i = 1; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (pinned.has(best[i].id) || pinned.has(best[j].id)) continue;
      const s = best.slice(); [s[i], s[j]] = [s[j], s[i]];
      const c = totalCost(s, ctx);
      if (c < bestCost - 1e-9) { best = s; bestCost = c; }
    }
    return { order: best.map(x => x.id), prof };
  }

  // A transition is weak when it costs about as much as an off-chart key move
  function isWeak(a, b, ctx) { return transitionCost(a, b, ctx || { shape: 'lg' }) >= W.weak; }

  // Up to `limit` bridge tracks from `pool` that fit between a and b (key and BPM on both sides, energy in between)
  function suggestBridges(a, b, pool, limit = 5) {
    const ctx = { shape: 'lg' }, mid = (a.energy + b.energy) / 2;
    return pool
      .filter(x => x.camelot && x.bpm && x.energy != null && x.id !== a.id && x.id !== b.id)
      .map(x => ({ track: x, cost: transitionCost(a, x, ctx) + transitionCost(x, b, ctx) + .5 * Math.abs(x.energy - mid) }))
      .sort((p, q) => p.cost - q.cost)
      .slice(0, limit)
      .map(z => z.track);
  }

  // ── Shape classifier for the Like examples: nearest of the four cluster centres ──
  // Fitted Oct 24 2026 MT on the 75 in-scope sets with 5+ scored tracks (agrees with the clustering on 69 of 75).
  const CLS = {
    mu: { E: .7557, Eslope: -.0414, Erange: .3786, turns: .576, B: 127.7003, Bslope: -.0122, Bspread: 7.1319, minor: .6916, harm: .656 },
    sd: { E: .0661, Eslope: .1391, Erange: .1344, turns: .2291, B: 2.7886, Bslope: 11.1326, Bspread: 5.5421, minor: .166, harm: .187 },
    c: {
      lg: { E: .614, Eslope: .157, Erange: -.687, turns: .051, B: .32, Bslope: .078, Bspread: -.229, minor: .498, harm: .286 },
      cl: { E: -.75, Eslope: 1.164, Erange: .728, turns: .084, B: -1.17, Bslope: .953, Bspread: .914, minor: -.568, harm: -1.026 },
      rr: { E: -.641, Eslope: -.224, Erange: .52, turns: -.334, B: .793, Bslope: -.442, Bspread: -.058, minor: -.528, harm: -.009 },
      so: { E: -.526, Eslope: -1.071, Erange: .934, turns: .221, B: -1.193, Bslope: -.373, Bspread: .116, minor: -.447, harm: -.122 },
    },
  };
  const slope = v => { const n = v.length, mx = (n - 1) / 2, my = v.reduce((p, q) => p + q, 0) / n; let num = 0, den = 0; v.forEach((y, x) => { num += (x - mx) * (y - my); den += (x - mx) ** 2; }); return (den ? num / den : 0) * (n - 1); };
  // Returns 'lg' | 'cl' | 'rr' | 'so', or null for sets with fewer than 5 scored tracks
  function classifyShape(seq) {
    const s = seq.filter(x => x.camelot && x.bpm && x.energy != null);
    if (s.length < 5) return null;
    const e = s.map(x => x.energy), b = s.map(x => x.bpm), k = s.map(x => x.camelot);
    let turns = 0, harm = 0;
    for (let i = 1; i < e.length - 1; i++) if ((e[i] - e[i - 1]) * (e[i + 1] - e[i]) < 0 && Math.abs(e[i] - e[i - 1]) > .05) turns++;
    for (let i = 1; i < k.length; i++) if (tier(k[i - 1], k[i]) !== 'other') harm++;
    const mean = v => v.reduce((p, q) => p + q, 0) / v.length;
    const sb = b.slice().sort((p, q) => p - q), mb = sb.length % 2 ? sb[(sb.length - 1) / 2] : (sb[sb.length / 2 - 1] + sb[sb.length / 2]) / 2;
    const f = { E: mean(e), Eslope: slope(e), Erange: Math.max(...e) - Math.min(...e), turns: turns / (e.length - 2), B: mb, Bslope: slope(b),
      Bspread: Math.sqrt(mean(b.map(x => (x - mean(b)) ** 2))), minor: k.filter(x => x.endsWith('A')).length / k.length, harm: harm / (k.length - 1) };
    let bestK = null, bestD = Infinity;
    for (const [key, c] of Object.entries(CLS.c)) {
      let d = 0; for (const name in c) d += (((f[name] - CLS.mu[name]) / CLS.sd[name]) - c[name]) ** 2;
      if (d < bestD) { bestD = d; bestK = key; }
    }
    return bestK;
  }

  // ── Templates: "make it feel like these sets" (Fill's Like picker) ──
  // A template is the sets' energy curves and tempo drift on a 0..1 position scale, averaged,
  // plus the share of each key-move type they use and how often their energy turns.
  const TPL_STEPS = 41;
  function tplAt(curve, p) {
    const x = Math.max(0, Math.min(1, p)) * (curve.length - 1), i = Math.floor(x), f = x - i;
    return i >= curve.length - 1 ? curve[curve.length - 1] : curve[i] * (1 - f) + curve[i + 1] * f;
  }
  function buildTemplate(sets) {
    const usable = sets.map(s => s.filter(x => x.camelot && x.bpm && x.energy != null)).filter(s => s.length >= 5);
    if (!usable.length) return null;
    const energy = new Array(TPL_STEPS).fill(0), bpmDrift = new Array(TPL_STEPS).fill(0), tiers = {};
    let resid = 0, residN = 0, turns = 0, inner = 0, steps = 0;
    for (const s of usable) {
      const e = s.map(x => x.energy), b = s.map(x => x.bpm), sb = b.slice().sort((p, q) => p - q), med = sb[Math.floor(sb.length / 2)];
      const bAdj = b.map(v => { const d = [v, v / 2, v * 2].reduce((p, q) => Math.abs(q - med) < Math.abs(p - med) ? q : p); return d - med; }); // half/double time folded
      const start = bAdj.slice(0, 3).reduce((p, q) => p + q, 0) / Math.min(3, bAdj.length);
      for (let k = 0; k < TPL_STEPS; k++) {
        const p = k / (TPL_STEPS - 1);
        energy[k] += tplAt(e, p) / usable.length;
        bpmDrift[k] += (tplAt(bAdj, p) - start) / usable.length;
      }
      for (let i = 1; i < s.length; i++) { const t = tier(s[i - 1].camelot, s[i].camelot); tiers[t] = (tiers[t] || 0) + 1; steps++; }
      for (let i = 1; i < e.length - 1; i++) { inner++; if ((e[i] - e[i - 1]) * (e[i + 1] - e[i]) < 0) turns++; }
    }
    for (const t in tiers) tiers[t] /= steps;
    // Tolerance: how far the sets' tracks sit from their own averaged curve (kept between 0.05 and 0.12)
    for (const s of usable) s.forEach((x, i) => { if (x.energy != null) { resid += (x.energy - tplAt(energy, s.length > 1 ? i / (s.length - 1) : 0)) ** 2; residN++; } });
    const energyTol = Math.max(.05, Math.min(.12, Math.sqrt(resid / Math.max(1, residN)) * .6));
    return { energy, bpmDrift, tiers, energyTol, bpmTol: 4, turnRate: inner ? turns / inner : 0, sets: usable.length };
  }

  /* Fill: pick `count` tracks from `pool` to follow `prefix` (the playlist's own tracks, opener first).
   * opts: { prefix, pool, count, shape, pulse, tpl } — tracks are { id, camelot, bpm, energy }.
   * Beam search over positions prefix.length .. prefix.length + count - 1 against the shape or template
   * target for a set of the final length. Returns the picked ids in order (the caller re-sequences). */
  function fill(opts) {
    const prefix = opts.prefix, n = prefix.length + opts.count, o = prefix[0];
    const ctx = { shape: opts.shape, pulse: !!opts.pulse, prof: null, tpl: opts.tpl || null };
    const pool = opts.pool.filter(x => x.camelot && x.bpm && x.energy != null && !prefix.some(y => y.id === x.id));
    let beams = [{ s: prefix.slice(), c: 0, used: new Set() }];
    for (let pos = prefix.length; pos < n; pos++) {
      const next = [];
      for (const bm of beams) {
        const last = bm.s[bm.s.length - 1], prev = bm.s.length > 1 ? bm.s[bm.s.length - 2] : null;
        // Keep the 40 cheapest candidates per beam so the search stays quick on a phone
        const scored = [];
        for (const x of pool) {
          if (bm.used.has(x.id)) continue;
          scored.push({ x, c: transitionCost(last, x, ctx) + pulseCost(prev, last, x, ctx) + shapeCost(x, pos, n, o, ctx) });
        }
        scored.sort((a, b) => a.c - b.c);
        for (const z of scored.slice(0, 40)) {
          const used = new Set(bm.used); used.add(z.x.id);
          next.push({ s: bm.s.concat(z.x), c: bm.c + z.c, used });
        }
      }
      next.sort((a, b) => a.c - b.c);
      // Keep beams that differ in their latest pick, so one strong track doesn't crowd out the rest
      const seen = new Set(); beams = [];
      for (const bm of next) { const k = bm.s.slice(prefix.length).map(x => x.id).sort().join(); if (seen.has(k)) continue; seen.add(k); beams.push(bm); if (beams.length >= W.beam) break; }
      if (!beams.length) break;
    }
    return beams[0].s.slice(prefix.length).map(x => x.id);
  }

  // The shape's target band at position p (0..1), for drawing: { energy, bpm, energyTol, bpmTol }
  function shapeTarget(p, n, opener, ctx) {
    const [energy, bpm] = target(p, n, opener, ctx);
    return { energy, bpm, energyTol: energyTol(ctx), bpmTol: bpmTol(ctx) };
  }

  const api = { SHAPES, tier, transitionCost, isWeak, sequence, suggestBridges, profile, classifyShape, totalCost, shapeTarget, buildTemplate, fill };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NLTDFSequencer = api;
})(typeof window !== 'undefined' ? window : globalThis);
