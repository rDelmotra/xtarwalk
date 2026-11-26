// Pure logic (no three.js, no DOM): work out WHICH real objects the user pointed at, from nothing but the
// pointing directions. Frame: +Y up, +X East, -Z North (skyRoot-local for candidates, world for taps).
//
// The headset knows gravity, so each pointing direction's HEIGHT above the horizon is trustworthy even when
// the compass (yaw) is completely wrong. And the ANGLE between two pointing directions does not depend on yaw
// at all. So a pair of taps is matched against every pair of bright objects whose heights and separation fit,
// a rotation is fitted for each, and the best-fitting, brightest pair wins. This is how star trackers work.
import { fitRotation, quatRotate, angleDeg } from './skyFit.js';

const R2D = 180 / Math.PI;
const altOf = (v) => Math.asin(Math.max(-1, Math.min(1, v.y / (Math.hypot(v.x, v.y, v.z) || 1)))) * R2D;
const nrm = (v) => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };

export const DEFAULTS = {
  altTolDeg: 6,      // a pointing hand is good to a few degrees in height
  sepTolDeg: 6,      // ...and in the angle between two taps
  fitTolDeg: 5,      // every tap must land within this of its object after the fit
  minSepDeg: 8,      // two taps closer than this don't pin a rotation well
  maxTiltDeg: 3,     // gravity is known: a fit may only tilt the sky a little
  magWeight: 0.5,    // brighter objects are what people actually point at
  ambiguityMargin: 1.2 // a rival this close in score (with different names) -> ask for one more tap
};

const magScore = (m) => Math.max(-1.5, Math.min(2.6, Number.isFinite(m) ? m : 2.6)); // the Moon is not 12x likelier

/**
 * @param {{x,y,z}[]} taps world pointing directions, in the order the user made them (2 or more)
 * @param {{name:string, s:{x,y,z}, mag:number, weight?:number}[]} candidates bright objects above the horizon,
 *   `s` = our computed direction (skyRoot-local)
 * @returns {{ok:true, matches:{tap:number, cand:object}[], q:{x,y,z,w}, rmsDeg:number, ambiguous:boolean, rival?:object}
 *   | {ok:false, reason:'need-two'|'too-close'|'no-match'}}
 */
export function identifyTaps(taps, candidates, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!Array.isArray(taps) || taps.length < 2) return { ok: false, reason: 'need-two' };
  const T = taps.map(nrm);
  const C = candidates.map((c) => ({ ...c, s: nrm(c.s), alt: altOf(c.s) }));
  const sep01 = angleDeg(T[0], T[1]);
  if (sep01 < o.minSepDeg) return { ok: false, reason: 'too-close' };
  const tAlt = T.map(altOf);

  const hyps = [];
  for (const a of C) {
    if (Math.abs(a.alt - tAlt[0]) > o.altTolDeg) continue;
    for (const b of C) {
      if (b === a || Math.abs(b.alt - tAlt[1]) > o.altTolDeg) continue;
      if (Math.abs(angleDeg(a.s, b.s) - sep01) > o.sepTolDeg) continue;
      const used = [a, b];
      const pairs = [{ s: a.s, w: T[0], weight: a.weight ?? 1 }, { s: b.s, w: T[1], weight: b.weight ?? 1 }];
      let fit = fitRotation(pairs, { maxTiltDeg: o.maxTiltDeg });
      if (Math.max(...fit.residuals) > o.fitTolDeg) continue;
      // extra taps: each must land on some other bright object under this rotation
      let missing = 0;
      for (let k = 2; k < T.length; k++) {
        let best = null, bestAng = Infinity;
        for (const c of C) {
          if (used.includes(c)) continue;
          const ang = angleDeg(quatRotate(fit.q, c.s), T[k]);
          if (ang > o.fitTolDeg) continue;
          // nearest wins, but within a degree the brighter one does (that's what people point at)
          if (!best || ang < bestAng - 1 || (Math.abs(ang - bestAng) <= 1 && magScore(c.mag) < magScore(best.mag))) {
            best = c; bestAng = ang;
          }
        }
        if (!best) { missing++; used.push(null); continue; }
        used.push(best);
        pairs.push({ s: best.s, w: T[k], weight: best.weight ?? 1 });
      }
      if (pairs.length > 2) fit = fitRotation(pairs, { maxTiltDeg: o.maxTiltDeg });
      const mags = used.filter(Boolean).reduce((acc, c) => acc + magScore(c.mag), 0) / used.filter(Boolean).length;
      const score = fit.rmsDeg + o.magWeight * mags + missing * o.fitTolDeg;
      hyps.push({ used, q: fit.q, rmsDeg: fit.rmsDeg, score, missing });
    }
  }
  if (!hyps.length) return { ok: false, reason: 'no-match' };
  hyps.sort((x, y) => x.score - y.score);
  const best = hyps[0];
  const key = (h) => h.used.slice(0, 2).map((c) => c?.name).join('|');
  const rival = hyps.find((h) => key(h) !== key(best));
  const ambiguous = !!rival && rival.missing === 0 && rival.score - best.score < o.ambiguityMargin;
  return {
    ok: true,
    matches: best.used.map((cand, tap) => ({ tap, cand })).filter((m) => m.cand),
    q: best.q,
    rmsDeg: best.rmsDeg,
    ambiguous,
    rival: ambiguous ? { names: rival.used.filter(Boolean).map((c) => c.name) } : undefined
  };
}
