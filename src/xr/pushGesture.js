import * as THREE from 'three';

/**
 * Two-handed "push toward the sky" detector (hand tracking, with a controller fallback).
 *
 * PUSH = within WINDOW_S both hands move >= MIN_PUSH_M further from the head, end with open palms
 * facing away from the head, both pointing > MIN_ELEV_DEG above the horizon and within MAX_SPREAD_DEG
 * of each other. Controllers: both squeeze buttons held + both pushed out >= MIN_PUSH_M.
 * Event: { dirWorld: Vector3 (unit, average push direction), altDeg }.
 */
export const PUSH_DEFAULTS = {
  windowS: 0.7,          // the whole push must happen inside this window
  minPushM: 0.22,        // growth of head->wrist distance inside the window
  smoothS: 0.05,         // EMA time constant for joint positions / palm normal / openness
  openOn: 0.8,           // openness >= this => palm open
  openOff: 0.6,          // openness <= this => curled (hysteresis: open stays open until below this)
  ratioCurled: 1.3,      // tip-to-wrist / metacarpal-to-wrist ratio mapping to openness 0
  ratioOpen: 2.5,        // ... and to openness 1 (extended fingers are ~2.6x, fists ~1.2x)
  facingDot: 0.5,        // dot(palmNormal, headToHand) must exceed this
  minElevDeg: 10,        // push direction must point at the sky
  maxSpreadDeg: 25,      // the two hands' directions must agree
  debounceS: 1.5
};

const FINGERS = ['index', 'middle', 'ring', 'pinky'];
const J = {
  wrist: 'wrist',
  indexMeta: 'index-finger-metacarpal',
  pinkyMeta: 'pinky-finger-metacarpal'
};
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const RAD2DEG = 180 / Math.PI;

export class PushGesture {
  /** @param {THREE.WebGLRenderer} renderer @param {Partial<typeof PUSH_DEFAULTS>} [opts] */
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.cfg = { ...PUSH_DEFAULTS, ...opts };
    this.t = 0;
    this.lastFireT = -Infinity;
    this.slots = [0, 1].map((i) => this._makeSlot(i));
    /** last evaluated state, for dev inspection */
    this.debug = null;
    this._head = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._c = new THREE.Vector3();
  }

  _makeSlot(i) {
    const hand = this.renderer.xr.getHand(i);
    const controller = this.renderer.xr.getController(i);
    const slot = {
      hand,
      controller,
      handedness: i === 0 ? 'left' : 'right', // overwritten by the 'connected' event
      controllerConnected: false,
      squeezed: false,
      valid: false,
      mode: null,
      pos: new THREE.Vector3(),
      palm: new THREE.Vector3(),
      openness: 0,
      isOpen: false,
      dir: new THREE.Vector3(),
      history: [] // {t, dist}
    };
    hand.addEventListener('connected', (e) => { if (e.data && e.data.handedness) slot.handedness = e.data.handedness; });
    controller.addEventListener('connected', (e) => {
      slot.controllerConnected = true;
      if (e.data && e.data.handedness && e.data.handedness !== 'none') slot.handedness = e.data.handedness;
    });
    controller.addEventListener('disconnected', () => { slot.controllerConnected = false; slot.squeezed = false; });
    controller.addEventListener('squeezestart', () => { slot.squeezed = true; });
    controller.addEventListener('squeezeend', () => { slot.squeezed = false; });
    return slot;
  }

  /** Forget everything (call at XR session start). */
  reset() {
    this.lastFireT = -Infinity;
    for (const s of this.slots) { s.valid = false; s.history.length = 0; s.mode = null; }
  }

  _jointPos(slot, name, out) {
    const j = slot.hand.joints && slot.hand.joints[name];
    if (!j || j.visible === false) return null;
    return out.setFromMatrixPosition(j.matrixWorld);
  }

  /** Sample one slot into slot.{pos,palm,openness}. Returns false when untracked. */
  _sample(slot, alpha, raw) {
    const hand = slot.hand;
    if (hand.joints && hand.joints[J.wrist]) {
      hand.updateWorldMatrix(true, true); // joint matrices are set by the XR manager this frame
      const wrist = this._jointPos(slot, J.wrist, this._a);
      const iMeta = this._jointPos(slot, J.indexMeta, this._b);
      const pMeta = this._jointPos(slot, J.pinkyMeta, this._c);
      if (wrist && iMeta && pMeta) {
        raw.pos.copy(wrist);
        // palm normal: cross(wrist->index, wrist->pinky) points out of the palm for a right hand
        const iv = iMeta.clone().sub(wrist);
        const pv = pMeta.clone().sub(wrist);
        raw.palm.crossVectors(iv, pv).normalize();
        if (slot.handedness === 'left') raw.palm.negate();
        // openness: mean tip/metacarpal reach over the four fingers
        let sum = 0;
        let n = 0;
        const w = wrist.clone();
        for (const f of FINGERS) {
          const tip = this._jointPos(slot, `${f}-finger-tip`, this._b);
          if (!tip) continue;
          const tipD = tip.distanceTo(w);
          const meta = this._jointPos(slot, `${f}-finger-metacarpal`, this._c);
          if (!meta) continue;
          const metaD = meta.distanceTo(w);
          if (metaD < 1e-4) continue;
          sum += tipD / metaD;
          n++;
        }
        if (n >= 3) {
          const { ratioCurled: lo, ratioOpen: hi } = this.cfg;
          raw.openness = clamp01(((sum / n) - lo) / (hi - lo));
          raw.mode = 'hand';
          return true;
        }
      }
    }
    if (slot.controllerConnected && slot.controller) {
      slot.controller.updateWorldMatrix(true, false);
      raw.pos.setFromMatrixPosition(slot.controller.matrixWorld);
      raw.openness = slot.squeezed ? 1 : 0;
      raw.palm.set(0, 0, 0);
      raw.mode = 'controller';
      return true;
    }
    return false;
  }

  /**
   * @param {number} dt seconds
   * @param {THREE.Object3D} headCamera the XR camera (position in world space)
   * @returns {{dirWorld: THREE.Vector3, altDeg: number}|null}
   */
  update(dt, headCamera) {
    const cfg = this.cfg;
    this.t += dt;
    this._head.copy(headCamera.position);
    const alpha = 1 - Math.exp(-Math.max(dt, 1e-4) / cfg.smoothS);
    const raw = { pos: new THREE.Vector3(), palm: new THREE.Vector3(), openness: 0, mode: null };

    for (const s of this.slots) {
      if (!this._sample(s, alpha, raw)) { s.valid = false; s.history.length = 0; s.mode = null; continue; }
      if (!s.valid || s.mode !== raw.mode) {
        s.pos.copy(raw.pos); s.palm.copy(raw.palm); s.openness = raw.openness;
        s.isOpen = raw.openness >= cfg.openOn;
        s.history.length = 0;
      } else {
        s.pos.lerp(raw.pos, alpha);
        s.palm.lerp(raw.palm, alpha);
        s.openness += (raw.openness - s.openness) * alpha;
        if (s.isOpen) { if (s.openness <= cfg.openOff) s.isOpen = false; } else if (s.openness >= cfg.openOn) s.isOpen = true;
      }
      s.valid = true;
      s.mode = raw.mode;
      s.dir.copy(s.pos).sub(this._head);
      const dist = s.dir.length();
      if (dist > 1e-4) s.dir.multiplyScalar(1 / dist);
      s.history.push({ t: this.t, dist });
      while (s.history.length && this.t - s.history[0].t > cfg.windowS) s.history.shift();
    }

    if (this.t - this.lastFireT < cfg.debounceS) return null;
    const [a, b] = this.slots;
    if (!a.valid || !b.valid) return null;

    const dbg = { push: [0, 0], open: [a.isOpen, b.isOpen], facing: [0, 0], spreadDeg: 0, altDeg: 0 };
    this.debug = dbg;
    for (let k = 0; k < 2; k++) {
      const s = this.slots[k];
      let min = Infinity;
      for (const h of s.history) if (h.dist < min) min = h.dist;
      const cur = s.history.length ? s.history[s.history.length - 1].dist : 0;
      dbg.push[k] = cur - min;
      if (dbg.push[k] < cfg.minPushM) return null;
      if (!s.isOpen) return null;
      if (s.mode === 'hand') {
        dbg.facing[k] = s.palm.dot(s.dir);
        if (dbg.facing[k] <= cfg.facingDot) return null;
      }
    }

    const spread = Math.acos(Math.max(-1, Math.min(1, a.dir.dot(b.dir)))) * RAD2DEG;
    dbg.spreadDeg = spread;
    if (spread > cfg.maxSpreadDeg) return null;
    const dirWorld = new THREE.Vector3().addVectors(a.dir, b.dir);
    if (dirWorld.lengthSq() < 1e-6) return null;
    dirWorld.normalize();
    const altDeg = Math.asin(Math.max(-1, Math.min(1, dirWorld.y))) * RAD2DEG;
    dbg.altDeg = altDeg;
    if (altDeg < cfg.minElevDeg) return null;

    this.lastFireT = this.t;
    for (const s of this.slots) s.history.length = 0;
    return { dirWorld, altDeg };
  }
}
