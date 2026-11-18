import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TwistGesture } from './twistGesture.js';

const RAD = Math.PI / 180;
const POINT = new THREE.Vector3(0, 0, -1);
const start = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 1.1, 0.2));
const startAxis = POINT.clone().applyQuaternion(start);
const q = new THREE.Quaternion();
// orientation = start rotated about its own local -Z by deg (clockwise-as-seen = positive)
const twisted = (deg) => q.copy(start).multiply(new THREE.Quaternion().setFromAxisAngle(POINT, deg * RAD));

function run(g, degs, dt = 1 / 72) {
  let sum = 0;
  let last;
  for (const d of degs) { last = g.update(twisted(d), dt); sum += last.deltaDeg; }
  return { sum, last };
}
const ramp = (to, n = 60) => Array.from({ length: n + 1 }, (_, i) => (to * i) / n);
const settle = (g, deg) => { for (let i = 0; i < 30; i++) g.update(twisted(deg), 1 / 72); };

test('twist about pointing axis counts fully (after engage offset)', () => {
  const g = new TwistGesture({ engageDeg: 8 });
  g.start(start);
  const { sum } = run(g, ramp(60));
  let tail = 0;
  for (let i = 0; i < 30; i++) tail += g.update(twisted(60), 1 / 72).deltaDeg;
  assert.ok(Math.abs(sum + tail - 52) < 0.5, `got ${sum + tail}`);
  assert.equal(g.engaged, true);
});

test('negative twist is negative; below threshold does not engage', () => {
  const g = new TwistGesture();
  g.start(start);
  run(g, ramp(5));
  settle(g, 5);
  assert.equal(g.engaged, false);
  const g2 = new TwistGesture();
  g2.start(start);
  const { sum } = run(g2, ramp(-40));
  settle(g2, -40);
  assert.ok(g2.engaged && g2.totalDeg < -39);
  assert.ok(sum < -20);
});

test('unwraps across +-180', () => {
  const g = new TwistGesture();
  g.start(start);
  run(g, ramp(300, 150));
  settle(g, 300);
  assert.ok(Math.abs(g.totalDeg - 300) < 1, `total ${g.totalDeg}`);
});

test('pure swing (pointing elsewhere, no roll) counts ~0', () => {
  const g = new TwistGesture();
  g.start(start);
  // rotate about a world axis perpendicular to the pointing axis
  const perp = new THREE.Vector3().crossVectors(startAxis, new THREE.Vector3(0, 1, 0)).normalize();
  for (let i = 0; i <= 90; i++) {
    const swing = new THREE.Quaternion().setFromAxisAngle(perp, (i * RAD * 60) / 90);
    q.copy(swing).multiply(start); // world-frame swing of the whole controller
    g.update(q, 1 / 72);
  }
  assert.equal(g.engaged, false);
  assert.ok(Math.abs(g.totalDeg) < 1, `total ${g.totalDeg}`);
});

test('translation is irrelevant (only quaternion is consumed)', () => {
  const g = new TwistGesture();
  g.start(start);
  const obj = { x: 0, y: 0, z: 0, w: 1, position: { x: 5, y: 5, z: 5 } };
  const { last } = run(g, ramp(0, 5));
  assert.equal(last.engaged, false);
  void obj;
});

test('end() resets', () => {
  const g = new TwistGesture();
  g.start(start);
  run(g, ramp(40));
  g.end();
  assert.equal(g.update(twisted(40)).engaged, false);
});
