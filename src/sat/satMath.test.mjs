import test from 'node:test';
import assert from 'node:assert/strict';
import { inEarthShadow, sunEciUnit, sunAltitudeDeg } from './satMath.js';

test('shadow: behind Earth is dark, sunward and far-off-axis are lit', () => {
  const sun = { x: 1, y: 0, z: 0 };
  assert.equal(inEarthShadow({ x: -7000, y: 0, z: 0 }, sun), true);
  assert.equal(inEarthShadow({ x: 7000, y: 0, z: 0 }, sun), false);
  assert.equal(inEarthShadow({ x: -7000, y: 7000, z: 0 }, sun), false);
});

test('sun vector is unit length and near the vernal direction at the March equinox', () => {
  const s = sunEciUnit(new Date('2026-03-20T14:46:00Z'));
  assert.ok(Math.abs(Math.hypot(s.x, s.y, s.z) - 1) < 1e-9);
  assert.ok(s.x > 0.999 && Math.abs(s.z) < 0.01);
});

test('sun altitude: equator observer facing the sun is ~90, antipode ~-90', () => {
  const sun = { x: 1, y: 0, z: 0 };
  assert.ok(Math.abs(sunAltitudeDeg(sun, 0, 0, 0) - 90) < 1e-6);
  assert.ok(Math.abs(sunAltitudeDeg(sun, 0, 0, 180) + 90) < 1e-6);
});
