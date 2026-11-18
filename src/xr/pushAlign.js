import * as THREE from 'three';
import { PushGesture } from './pushGesture.js';
import { PushHint } from './pushHint.js';
import { PushResolver, dirFromAltAz } from '../calibration/autoAlign.js';

/**
 * Glue for gesture-driven re-calibration: PushGesture -> PushResolver (altitude match) ->
 * calibrator.snapToTarget -> confirmation. Also owns the look-up PushHint.
 * main.js only constructs this and calls update()/startSession().
 */
export class PushAlign {
  /**
   * @param {object} d
   * @param {THREE.WebGLRenderer} d.renderer
   * @param {THREE.Scene} d.scene
   * @param {{snapToTarget:Function}} d.calibrator
   * @param {()=>Array} d.getCandidates  reference candidates (brightest first), each {name, alt, mag, pos}
   * @param {()=>boolean} d.isBusy       scrubbing / calibrating / finding / not live
   * @param {()=>boolean} d.isXR
   * @param {(target:object, deg:number)=>void} d.onAligned  confirmation path in main.js
   * @param {()=>void} [d.haptic]
   * @param {(text:string)=>void} [d.onMessage] DOM status for failures (desktop/dev)
   */
  constructor(d) {
    this.d = d;
    this.gesture = new PushGesture(d.renderer);
    this.hint = new PushHint(d.scene);
    this.resolver = new PushResolver();
  }

  _say(text, seconds = 3) {
    this.hint.flash(text, seconds);
    if (this.d.onMessage) this.d.onMessage(text);
  }

  startSession() {
    this.gesture.reset();
    this.hint.reset();
    this.resolver.reset();
  }

  /** Per frame, XR only. headCamera = renderer.xr.getCamera() */
  update(dt, headCamera) {
    if (!this.d.isXR()) { this.hint.update(dt, headCamera, { enabled: false }); return; }
    const busy = this.d.isBusy();
    const cands = busy ? [] : this.d.getCandidates();
    this.hint.update(dt, headCamera, { enabled: !busy, label: cands[0] && cands[0].name });
    if (busy) return;
    const ev = this.gesture.update(dt, headCamera);
    if (ev) this.handlePush(ev);
  }

  /** @param {{dirWorld:{x:number,y:number,z:number}, altDeg:number}} ev */
  handlePush(ev) {
    const { d } = this;
    if (d.isBusy()) {
      this._say('Return to the live sky to align');
      return null;
    }
    const target = this.resolver.resolve(d.getCandidates(), ev.altDeg, performance.now());
    if (!target) {
      this._say('Push toward the Moon or a bright star');
      return null;
    }
    const deg = d.calibrator.snapToTarget(target.pos, ev.dirWorld);
    this.hint.markCalibrated();
    this.hint.flash(`Locked to ${target.name} — ${deg.toFixed(0)}° correction. Not ${target.name}? Push again.`, 4);
    if (d.haptic) d.haptic();
    d.onAligned(target, deg);
    return { target, deg };
  }

  /** Desktop/dev hook: same handler, no hands. */
  simulatePush(altDeg, azWorldDeg = 0) {
    const v = dirFromAltAz(altDeg, azWorldDeg);
    return this.handlePush({ dirWorld: new THREE.Vector3(v.x, v.y, v.z), altDeg });
  }
}
