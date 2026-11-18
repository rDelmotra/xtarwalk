import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseReference, PushResolver, dirFromAltAz, altOfDir } from './autoAlign.js';
import { SkyCalibrator } from './calibration.js';

const C = [
  { name: 'Moon', alt: 40, mag: -12 },
  { name: 'Vega', alt: 62, mag: 0.03 },
  { name: 'Arcturus', alt: 60, mag: -0.05 },
  { name: 'Capella', alt: 20, mag: 0.08 },
  { name: 'Jupiter', alt: 20.5, mag: -2 }
];

test('matches by altitude within tolerance', () => {
  assert.equal(chooseReference(C, 38).name, 'Moon');
  assert.equal(chooseReference(C, 46), null);
  assert.equal(chooseReference(C, 10), null);
});

test('brightest wins when several match', () => {
  assert.equal(chooseReference(C, 20).name, 'Jupiter');
  assert.equal(chooseReference(C, 61).name, 'Arcturus');
});

test('exclude and invalid input', () => {
  assert.equal(chooseReference(C, 61, { exclude: ['Arcturus'] }).name, 'Vega');
  assert.equal(chooseReference(C, 61, { exclude: ['Arcturus', 'Vega'] }), null);
  assert.equal(chooseReference([], 30), null);
  assert.equal(chooseReference(C, NaN), null);
  assert.equal(chooseReference(C, 61, { tolDeg: 0.5 }), null);
});

test('second push within 6s at same elevation cycles; restarts after exhaustion', () => {
  const r = new PushResolver();
  assert.equal(r.resolve(C, 61, 0).name, 'Arcturus');
  assert.equal(r.resolve(C, 62, 2000).name, 'Vega');
  assert.equal(r.resolve(C, 62, 4000).name, 'Arcturus'); // exhausted -> wraps
});

test('no cycling after the window or at a different elevation', () => {
  const r = new PushResolver();
  assert.equal(r.resolve(C, 61, 0).name, 'Arcturus');
  assert.equal(r.resolve(C, 61, 7000).name, 'Arcturus');
  assert.equal(r.resolve(C, 40, 8000).name, 'Moon');
  assert.equal(r.resolve(C, 61, 9000).name, 'Arcturus');
});

test('failed match resets cycle state', () => {
  const r = new PushResolver();
  r.resolve(C, 61, 0);
  assert.equal(r.resolve(C, 5, 1000), null);
  assert.equal(r.resolve(C, 61, 2000).name, 'Arcturus');
});

test('dirFromAltAz round-trips and feeds snapToTarget', () => {
  const d = dirFromAltAz(40, 90);
  assert.ok(Math.abs(altOfDir(d) - 40) < 1e-9);
  assert.ok(d.x > 0 && Math.abs(d.z) < 1e-9);
  const cal = new SkyCalibrator();
  // target at az 90 (east), user pushed toward az 0 (-Z): sky must rotate by +90 deg
  const deg = cal.snapToTarget(dirFromAltAz(40, 90), dirFromAltAz(40, 0));
  assert.ok(Math.abs(deg - 90) < 1e-6);
});
