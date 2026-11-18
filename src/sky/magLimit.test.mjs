import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoLimit, MagControl, MAG_MIN, MAG_MAX } from './magLimit.js';

test('dark moonless night shows the base sky', () => {
  assert.equal(autoLimit({ sunAltDeg: -30, moonAltDeg: -20, moonPhase: 1 }), 5.5);
});

test('twilight and daylight hide faint stars', () => {
  const civil = autoLimit({ sunAltDeg: -6 });
  const day = autoLimit({ sunAltDeg: 10 });
  assert.ok(civil < 4 && civil > 1.5, `civil ${civil}`);
  assert.equal(day, MAG_MIN);
});

test('a high full Moon costs about a magnitude, a new Moon nothing', () => {
  const full = autoLimit({ sunAltDeg: -30, moonAltDeg: 40, moonPhase: 1 });
  const fresh = autoLimit({ sunAltDeg: -30, moonAltDeg: 40, moonPhase: 0 });
  assert.ok(Math.abs(full - 4.3) < 0.05, `full ${full}`);
  assert.equal(fresh, 5.5);
});

test('twisting offsets the auto value and clamps to the catalogue range', () => {
  const m = new MagControl();
  m.setAuto(5);
  m.turn(40);
  assert.ok(Math.abs(m.limit - 6) < 1e-9);
  assert.equal(m.isAuto, false);
  m.turn(400);
  assert.equal(m.limit, MAG_MAX);
  m.turn(-4000);
  assert.equal(m.limit, MAG_MIN);
  m.resetToAuto();
  assert.equal(m.limit, 5);
  assert.equal(m.labels.sub, 'Auto');
});
