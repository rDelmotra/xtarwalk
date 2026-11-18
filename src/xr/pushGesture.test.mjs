import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PushGesture } from './pushGesture.js';

// Fake hand: joints are Object3Ds whose matrixWorld we set directly.
function makeHand() {
  const hand = new THREE.Group();
  hand.joints = {};
  const names = ['wrist', 'index-finger-metacarpal', 'middle-finger-metacarpal', 'ring-finger-metacarpal', 'pinky-finger-metacarpal',
    'index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'];
  for (const n of names) { const j = new THREE.Object3D(); j.matrixAutoUpdate = false; hand.joints[n] = j; hand.add(j); }
  return hand;
}
function makeRenderer() {
  const hands = [makeHand(), makeHand()];
  const ctrls = [new THREE.Group(), new THREE.Group()];
  return { hands, ctrls, xr: { getHand: (i) => hands[i], getController: (i) => ctrls[i] } };
}
function setJoint(hand, name, p) { hand.joints[name].matrix.makeTranslation(p.x, p.y, p.z); }

/**
 * Pose a right-handed-style palm facing `dir` with fingers toward `up`-ish. Palm normal (right hand) = cross(index, pinky),
 * so for a LEFT hand we mirror pinky/index. Fingers extend `reach` x metacarpal length.
 */
function pose(hand, handedness, wristPos, dir, open) {
  const fwd = dir.clone().normalize();                       // palm normal (wanted)
  const up = Math.abs(fwd.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const finger = up.clone().sub(fwd.clone().multiplyScalar(up.dot(fwd))).normalize(); // wrist -> fingers
  // for a right hand: normal = cross(index, pinky); choose side so that holds
  let side = new THREE.Vector3().crossVectors(finger, fwd).normalize(); // candidate toward pinky? verify below
  const mk = (s) => {
    const idx = finger.clone().multiplyScalar(0.06).addScaledVector(side, -0.03 * s);
    const pnk = finger.clone().multiplyScalar(0.05).addScaledVector(side, 0.03 * s);
    return { idx, pnk };
  };
  let { idx, pnk } = mk(1);
  const n = new THREE.Vector3().crossVectors(idx, pnk).normalize();
  const sign = handedness === 'left' ? -1 : 1;
  if (n.multiplyScalar(sign).dot(fwd) < 0) side = side.negate();
  ({ idx, pnk } = mk(1));
  const metaLen = 0.06;
  const reach = open ? 2.8 : 1.3;
  setJoint(hand, 'wrist', wristPos);
  setJoint(hand, 'index-finger-metacarpal', wristPos.clone().add(idx));
  setJoint(hand, 'pinky-finger-metacarpal', wristPos.clone().add(pnk));
  setJoint(hand, 'middle-finger-metacarpal', wristPos.clone().addScaledVector(finger, metaLen));
  setJoint(hand, 'ring-finger-metacarpal', wristPos.clone().addScaledVector(finger, metaLen));
  for (const f of ['index', 'middle', 'ring', 'pinky']) {
    setJoint(hand, `${f}-finger-tip`, wristPos.clone().addScaledVector(finger, metaLen * reach));
  }
}

function runPush({ altDeg = 40, open = true, facing = true, spreadDeg = 0, distM = 0.35, dur = 0.5 }) {
  const r = makeRenderer();
  const pg = new PushGesture(r);
  pg.slots[0].handedness = 'left'; pg.slots[1].handedness = 'right';
  const head = new THREE.Object3D();
  head.position.set(0, 1.6, 0);
  const a = (altDeg * Math.PI) / 180;
  const dirOf = (side) => {
    const az = (side * spreadDeg / 2) * Math.PI / 180;
    return new THREE.Vector3(Math.cos(a) * Math.sin(az), Math.sin(a), -Math.cos(a) * Math.cos(az)).normalize();
  };
  let ev = null;
  const steps = 60;
  const dt = 1 / 60;
  for (let i = 0; i <= steps; i++) {
    const k = Math.min(1, (i * dt) / dur);
    const d = 0.25 + (distM - 0.0) * k; // 0.25 m -> 0.25+distM from head
    for (let h = 0; h < 2; h++) {
      const dir = dirOf(h === 0 ? -1 : 1);
      const wp = head.position.clone().addScaledVector(dir, d);
      wp.x += h === 0 ? -0.08 : 0.08;
      const palmN = facing ? dir : dir.clone().negate();
      pose(r.hands[h], h === 0 ? 'left' : 'right', wp, palmN, open && k > 0.3);
    }
    const e = pg.update(dt, head);
    if (e && !ev) ev = e;
  }
  return ev;
}

test('push toward the sky with open palms fires with the right elevation', () => {
  const ev = runPush({ altDeg: 40 });
  assert.ok(ev, 'expected an event');
  assert.ok(Math.abs(ev.altDeg - 40) < 4, `alt ${ev.altDeg}`);
  assert.ok(Math.abs(ev.dirWorld.length() - 1) < 1e-6);
});

test('short push, low elevation, closed fists, palms facing the head, wide spread: no event', () => {
  assert.equal(runPush({ altDeg: 40, distM: 0.1 }), null);
  assert.equal(runPush({ altDeg: 3 }), null);
  assert.equal(runPush({ altDeg: 40, open: false }), null);
  assert.equal(runPush({ altDeg: 40, facing: false }), null);
  assert.equal(runPush({ altDeg: 40, spreadDeg: 60 }), null);
});

test('debounce: only one event per 1.5 s', () => {
  const r = makeRenderer();
  const pg = new PushGesture(r);
  pg.lastFireT = pg.t; // just fired
  const head = new THREE.Object3D();
  assert.equal(pg.update(1 / 60, head), null);
});
