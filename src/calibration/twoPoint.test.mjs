import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyTaps } from './twoPoint.js';
import { quatRotate, quatMul, quatFromAxisAngle, angleDeg } from './skyFit.js';

const D = Math.PI / 180;
const Y = { x: 0, y: 1, z: 0 }, X = { x: 1, y: 0, z: 0 };
const dir = (az, alt) => { const a = az * D, e = alt * D; return { x: Math.sin(a) * Math.cos(e), y: Math.sin(e), z: -Math.cos(a) * Math.cos(e) }; };

// deterministic PRNG
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

/** A sky like a real one: ~45 objects brighter than mag 2 above the horizon (uniform over the dome). */
function makeSky(r, withMoon) {
  const out = [];
  for (let i = 0; i < 45; i++) {
    const alt = Math.asin(0.05 + 0.95 * r()) / D;
    out.push({ name: `S${i}`, s: dir(360 * r(), alt), mag: -1.5 + 3.5 * Math.sqrt(r()) });
  }
  if (withMoon) out.push({ name: 'Moon', s: dir(360 * r(), 15 + 60 * r()), mag: -11, weight: 2 });
  return out;
}

/** The user points at `objs` (by name) through a hand that is off by up to `noiseDeg`; the headset's yaw is unknown. */
function pointAt(sky, names, q, r, noiseDeg) {
  return names.map((n) => {
    const w = quatRotate(q, sky.find((c) => c.name === n).s);
    const j = () => (r() * 2 - 1) * noiseDeg * D * 0.7;
    return { x: w.x + j(), y: w.y + j(), z: w.z + j() };
  });
}
const truthQ = (r) => quatMul(quatFromAxisAngle(Y, 360 * r() * D), quatFromAxisAngle(X, (r() * 2 - 1) * D));
const brightest = (sky, n) => sky.slice().sort((a, b) => a.mag - b.mag).slice(0, n);
const alignErr = (qa, qb) => Math.max(...[dir(0, 30), dir(120, 50), dir(240, 70)].map((v) => angleDeg(quatRotate(qa, v), quatRotate(qb, v))));

test('rejects fewer than two taps and taps that are too close', () => {
  const sky = makeSky(rng(1), false);
  assert.equal(identifyTaps([dir(0, 30)], sky).reason, 'need-two');
  assert.equal(identifyTaps([dir(0, 30), dir(3, 32)], sky).reason, 'too-close');
});

test('no bright pair fits -> no-match', () => {
  const sky = [{ name: 'A', s: dir(0, 20), mag: 0 }, { name: 'B', s: dir(30, 20), mag: 0 }];
  assert.equal(identifyTaps([dir(0, 70), dir(90, 10)], sky).reason, 'no-match');
});

test('Moon + one bright star: identified (or flagged for one more tap), any compass error', () => {
  const r = rng(7);
  let ok = 0, n = 0, wrong = 0;
  for (let trial = 0; trial < 200; trial++) {
    const sky = makeSky(r, true);
    const moon = sky.find((c) => c.name === 'Moon');
    const star = brightest(sky.filter((c) => c.name !== 'Moon'), 6).find((c) => angleDeg(c.s, moon.s) > 20);
    if (!star) continue;
    n++;
    const q = truthQ(r);
    const res = identifyTaps(pointAt(sky, ['Moon', star.name], q, r, 2), sky);
    const right = res.ok && res.matches[0].cand.name === 'Moon' && res.matches[1].cand.name === star.name;
    // two taps from a hand good to ~2 deg pin the sky to ~3 deg; later real-sky taps refine it further
    if ((right && alignErr(res.q, q) < 3.5) || (res.ok && res.ambiguous)) ok++;
    else if (res.ok && !right) wrong++;
  }
  assert.ok(ok / n >= 0.95, `moon+star identified ${ok}/${n}`);
  assert.ok(wrong / n <= 0.03, `confidently wrong ${wrong}/${n}`);
});

test('two bright stars, no Moon: identified when confident, a third tap settles the doubtful ones', () => {
  const r = rng(42);
  let right = 0, wrongConfident = 0, n = 0, settled = 0, doubtful = 0;
  for (let trial = 0; trial < 300; trial++) {
    const sky = makeSky(r, false);
    const top = brightest(sky, 6);
    const a = top[0], b = top.slice(1).find((c) => angleDeg(c.s, a.s) > 20);
    if (!b) continue;
    n++;
    const q = truthQ(r);
    const res = identifyTaps(pointAt(sky, [a.name, b.name], q, r, 2), sky);
    const correct = res.ok && res.matches[0].cand.name === a.name && res.matches[1].cand.name === b.name;
    if (res.ok && res.ambiguous) {
      doubtful++;
      const c = top.find((x) => x !== a && x !== b && angleDeg(x.s, a.s) > 15 && angleDeg(x.s, b.s) > 15);
      if (!c) continue;
      const res3 = identifyTaps(pointAt(sky, [a.name, b.name, c.name], q, r, 2), sky);
      if (res3.ok && res3.matches.map((m) => m.cand.name).join() === [a.name, b.name, c.name].join()) settled++;
      continue;
    }
    if (correct) right++;
    else if (res.ok) wrongConfident++;
  }
  const confident = n - doubtful;
  assert.ok(right / confident >= 0.95, `confident & right ${right}/${confident}`);
  assert.ok(wrongConfident / n <= 0.04, `confidently wrong ${wrongConfident}/${n}`);
  if (doubtful) assert.ok(settled / doubtful >= 0.8, `third tap settled ${settled}/${doubtful}`);
});
