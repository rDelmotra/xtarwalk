import test from 'node:test';
import assert from 'node:assert/strict';
import { fitRotation, RefineSession, quatRotate, quatMul, quatFromAxisAngle, angleDeg, yawOf, tiltDegOf } from './skyFit.js';

const D = Math.PI / 180;
const Y = { x: 0, y: 1, z: 0 }, X = { x: 1, y: 0, z: 0 };
const dir = (az, alt) => { const a = az * D, e = alt * D; return { x: Math.sin(a) * Math.cos(e), y: Math.sin(e), z: -Math.cos(a) * Math.cos(e) }; };
const S = [dir(10, 40), dir(100, 25), dir(200, 60), dir(300, 15), dir(45, 70), dir(160, 35)];
const truth = (yaw, tilt) => quatMul(quatFromAxisAngle(Y, yaw * D), quatFromAxisAngle(X, tilt * D));
const mk = (q, n, noise = 0) => S.slice(0, n).map((s, i) => {
  const w = quatRotate(q, s);
  const j = noise * Math.sin(i * 12.9898 + 1) * D / 1.8; // deterministic jitter (per-vector <= ~0.3 deg)
  const k = noise * Math.cos(i * 78.233 + 2) * D / 1.8;
  return { s, w: { x: w.x + j, y: w.y + k, z: w.z - j } };
});
const qErr = (a, b) => angleDeg(quatRotate(a, dir(33, 41)), quatRotate(b, dir(33, 41)));

test('identity for identical pairs', () => {
  const r = fitRotation(S.map((s) => ({ s, w: s })));
  assert.ok(qErr(r.q, { x: 0, y: 0, z: 0, w: 1 }) < 1e-6);
  assert.ok(r.rmsDeg < 1e-6);
});

test('recovers known yaw+tilt from noise-free pairs', () => {
  const q = truth(37, 1.2);
  for (const n of [3, 4]) {
    const r = fitRotation(mk(q, n));
    assert.ok(qErr(r.q, q) < 0.01, `n=${n}`);
    assert.ok(r.rmsDeg < 0.01);
  }
});

test('small noise on 5 pairs recovers within 0.3 deg', () => {
  const q = truth(-20, 1.0);
  const r = fitRotation(mk(q, 5, 0.3));
  assert.ok(qErr(r.q, q) < 0.3, String(qErr(r.q, q)));
});

test('one pair gives pure yaw', () => {
  const q = truth(37, 1.2);
  const [p] = mk(q, 1);
  const r = fitRotation([p]);
  assert.ok(tiltDegOf(r.q) < 1e-9);
  const expected = quatRotate(quatFromAxisAngle(Y, 37 * D), p.s);
  // azimuth of rotated s matches the target's azimuth
  const got = quatRotate(r.q, p.s);
  assert.ok(Math.abs(Math.atan2(got.x, -got.z) - Math.atan2(p.w.x, -p.w.z)) < 1e-9);
  assert.ok(Math.abs(yawOf(r.q) - 37 * D) < 0.05);
  assert.ok(expected);
});

test('tilt guard falls back to yaw-only', () => {
  const q = truth(37, 6);
  const r = fitRotation(mk(q, 4), { maxTiltDeg: 3 });
  assert.ok(tiltDegOf(r.q) < 1e-9);
  const free = fitRotation(mk(q, 4), { maxTiltDeg: 10 });
  assert.ok(Math.abs(tiltDegOf(free.q) - 6) < 0.01);
});

test('RefineSession rejects a 15 deg outlier', () => {
  const q = truth(37, 1.2);
  const good = mk(q, 4);
  const ses = new RefineSession();
  for (const p of good) ses.add(p.s, p.w);
  const bad = quatRotate(quatFromAxisAngle({ x: 0, y: 0, z: 1 }, 15 * D), quatRotate(q, S[4]));
  const r = ses.add(S[4], bad);
  assert.equal(r.rejected, true);
  assert.equal(r.used, 4);
  assert.ok(r.rmsDeg < 0.5);
  assert.ok(qErr(r.q, q) < 0.5);
});

test('re-tap replaces rather than duplicates', () => {
  const q = truth(10, 0.5);
  const ses = new RefineSession();
  const [a, b, c] = mk(q, 3);
  ses.add(a.s, a.w); ses.add(b.s, b.w); ses.add(c.s, c.w);
  assert.equal(ses.count, 3);
  ses.add(a.s, a.w);
  assert.equal(ses.count, 3);
  ses.reset();
  assert.equal(ses.count, 0);
  assert.equal(ses.result, null);
});
