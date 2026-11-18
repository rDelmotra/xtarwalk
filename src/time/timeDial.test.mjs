import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeDial } from './timeDial.js';

const NOW = Date.parse('2026-03-20T13:00:00Z'); // ~18:30 in Delhi
const mk = () => new TimeDial({ lat: 28.6139, lon: 77.209, now: () => NOW });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('initial state is live, window is noon to noon around now', () => {
  const s = mk().state;
  assert.equal(s.isLive, true);
  assert.equal(s.offsetHours, 0);
  assert.equal(s.dayShift, 0);
  assert.ok(s.windowStart < s.date && s.date < s.windowEnd);
  near((s.windowEnd - s.windowStart) / 3.6e6, 24, 0.05);
  assert.ok(s.sunset && s.sunrise && s.sunset < s.sunrise);
  assert.match(s.label, /^Live · \d\d:\d\d$/);
  assert.equal(s.relLabel, 'Live');
});

test('small turns move 12 minutes per degree (desktop gain)', () => {
  const d = mk();
  d.begin();
  d.turn(15);
  near(d.state.offsetHours, 3, 1e-9);
  d.turn(-5);
  near(d.state.offsetHours, 2, 1e-9);
  assert.equal(d.state.relLabel, '+2h 0m');
  assert.match(d.state.label, /^Tonight · /);
  d.end();
  assert.equal(d.state.scrubbing, false);
  near(d.state.offsetHours, 2, 1e-9);
});

test('edge resists for 45 degrees then crosses continuously', () => {
  const d = mk();
  d.begin();
  const toEnd = (d.state.windowEnd - NOW) / 3.6e6; // hours
  d.turn(toEnd * 5 + 0.0001); // just at the edge
  let s = d.state;
  near(s.offsetHours, toEnd, 1e-3);
  d.turn(20);
  s = d.state;
  near(s.offsetHours, toEnd, 1e-3); // time did not move
  assert.equal(s.edge, 'end');
  near(s.resistance, 20 / 45, 1e-3);
  assert.equal(s.dayShift, 0);
  d.turn(24); // total extra 44+ => not yet
  assert.equal(d.state.dayShift, 0);
  d.turn(2); // crosses (46 total); 1 deg extra moves time
  s = d.state;
  assert.equal(s.dayShift, 1);
  assert.equal(s.resistance, 0);
  near(s.date - s.windowStart, 1 * 12 * 60000, 2000); // ~1 deg past new window start
  assert.match(s.label, /^Tomorrow afternoon/);
  assert.ok(d.consumeDayClick());
  assert.ok(!d.consumeDayClick());
});

test('backing off decays resistance, then time moves back', () => {
  const d = mk();
  d.begin();
  const toEnd = (d.state.windowEnd - NOW) / 3.6e6;
  d.turn(toEnd * 5 + 0.0001 + 30);
  near(d.state.resistance, 30 / 45, 1e-3);
  d.turn(-15);
  near(d.state.resistance, 15 / 45, 1e-3);
  d.turn(-16);
  near(d.state.resistance, 0, 1e-3);
  assert.equal(d.state.edge, 'none');
  d.turn(-4);
  near(d.state.offsetHours, toEnd - 1.0, 1e-2);
});

test('release decays resistance via tick', () => {
  const d = mk();
  d.begin();
  const toEnd = (d.state.windowEnd - NOW) / 3.6e6;
  d.turn(toEnd * 5 + 0.0001 + 30);
  d.end();
  assert.ok(d.state.resistance > 0.5);
  d.tick(0.1);
  assert.ok(d.state.resistance < 0.5);
  d.tick(0.3);
  assert.equal(d.state.resistance, 0);
  assert.equal(d.state.edge, 'none');
});

test('backward crossing into last night', () => {
  const d = mk();
  d.begin();
  const toStart = (NOW - d.state.windowStart) / 3.6e6;
  d.turn(-(toStart * 5) - 46);
  const s = d.state;
  assert.equal(s.dayShift, -1);
  assert.match(s.label, /^This morning/);
});

test('Now detent snaps within +-1.5 degrees but can be escaped', () => {
  const d = mk();
  d.begin();
  d.turn(10);
  d.turn(-9.5); // 0.5 deg = 6 min from live
  assert.equal(d.state.offsetHours, 0);
  assert.equal(d.state.isLive, true);
  d.turn(1); // 18 min raw -> out of detent
  near(d.state.offsetHours, 0.3, 1e-9);
  d.turn(-1.3);
  assert.equal(d.state.isLive, true);
  d.turn(5); // small increments escape the detent
  d.end();
  assert.ok(!d.state.isLive);
});

test('per-input gain: XR twist is 10 min per degree', () => {
  const d = mk();
  d.begin();
  d.turn(30, { gain: 10 });
  near(d.state.offsetHours, 5, 1e-9);
});

// simulate a fast drag then release; returns the dial after end()
function flick(d, dps, gain, frames = 12) {
  const dt = 1 / 60;
  d.begin();
  for (let i = 0; i < frames; i++) { d.turn(dps * dt, { gain }); d.tick(dt); }
  d.end();
}

test('coasting: fast release keeps moving, decays and stops, commits via scrubbing=false', () => {
  const d = mk();
  flick(d, 200, 12);
  assert.equal(d.state.coasting, true);
  assert.equal(d.state.scrubbing, true); // main must not commit yet
  const o0 = d.state.offsetHours;
  d.tick(1 / 60);
  assert.ok(d.state.offsetHours > o0);
  let n = 0;
  let prev = d.state.offsetHours;
  let lastStep = Infinity;
  while (d.state.coasting && n++ < 2000) {
    d.tick(1 / 60);
    const cur = d.state.offsetHours;
    const step = cur - prev;
    assert.ok(step <= lastStep + 1e-9, 'monotonically decelerating');
    lastStep = step; prev = cur;
  }
  assert.ok(n < 600, 'stops within ~10 s');
  assert.equal(d.state.coasting, false);
  assert.equal(d.state.scrubbing, false);
  assert.ok(d.state.offsetHours > o0 + 1);
});

test('slow release does not coast; wheel/keys (coast:false) never coast', () => {
  const d = mk();
  flick(d, 5, 12);
  assert.equal(d.state.coasting, false);
  const e = mk();
  e.begin({ coast: false });
  for (let i = 0; i < 12; i++) { e.turn(200 / 60); e.tick(1 / 60); }
  e.end();
  assert.equal(e.state.coasting, false);
});

test('coasting never crosses a window edge and resistance stays 0', () => {
  const d = mk();
  const toEnd = (d.state.windowEnd - NOW) / 3.6e6;
  d.begin();
  d.turn(toEnd * 5 - 15);
  d._vel = 0; d._acc = 0;
  for (let i = 0; i < 6; i++) { d.turn(0.5); d.tick(1 / 60); } // slow approach, ~30 dps
  d._vel = 700; // big flick toward the edge
  d.end();
  assert.equal(d.state.coasting, true);
  for (let i = 0; i < 1200 && d.state.coasting; i++) {
    d.tick(1 / 60);
    assert.ok(d.state.offsetHours <= toEnd + 1e-9, 'not past the edge');
    assert.equal(d.state.resistance, 0);
    assert.equal(d.state.dayShift, 0);
  }
  assert.equal(d.state.coasting, false);
  assert.ok(d.state.offsetHours > toEnd - 0.2, 'eased into the edge');
});

test('re-grab stops a coast instantly', () => {
  const d = mk();
  flick(d, 300, 12);
  d.tick(1 / 60);
  assert.equal(d.state.coasting, true);
  d.begin();
  const o = d.state.offsetHours;
  assert.equal(d.state.coasting, false);
  d.end();
  d.tick(0.1);
  assert.equal(d.state.offsetHours, o);
  assert.equal(d.state.scrubbing, false);
});

test('goLive returns to now', () => {
  const d = mk();
  let last;
  d.onChange((s) => { last = s; });
  d.begin();
  d.turn(100);
  assert.ok(!d.state.isLive);
  d.goLive();
  assert.equal(d.state.isLive, true);
  assert.equal(d.state.offsetHours, 0);
  assert.equal(d.state.scrubbing, false);
  assert.equal(last.isLive, true);
});

test('polar location falls back without throwing', () => {
  const d = new TimeDial({ lat: 80, lon: 10, now: () => Date.parse('2026-06-21T12:00:00Z') });
  const s = d.state;
  assert.ok(s.windowEnd > s.windowStart);
  d.begin(); d.turn(50); d.end();
  assert.ok(Number.isFinite(d.state.offsetHours));
});
