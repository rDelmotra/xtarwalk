import * as THREE from 'three';
import { XRHandModelFactory } from 'three/examples/jsm/webxr/XRHandModelFactory.js';
import { TwistGesture } from './twistGesture.js';

/**
 * Pinch / trigger input. A press is either:
 *  - a SELECT (released before the wrist twist engages) -> onSelectRay(raycaster built from the START ray), or
 *  - a SCRUB (twist engaged) -> onScrubBegin(controller) / onScrubTurn(deltaDeg, controller) / onScrubEnd().
 * Presses whose start ray fails `canScrub` (HUD hit, calibrating, finding) behave as before: select fires on press.
 */
export class XRInputManager {
  /**
   * @param {object} [opts]
   * @param {(raycaster:THREE.Raycaster)=>boolean} [opts.canScrub]
   * @param {(controller:THREE.Object3D)=>void} [opts.onScrubBegin]
   * @param {(deltaDeg:number, controller:THREE.Object3D)=>void} [opts.onScrubTurn]
   * @param {()=>void} [opts.onScrubEnd]
   */
  constructor(renderer, scene, onSelectRay, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.onSelectRay = onSelectRay;
    this.canScrub = opts.canScrub || (() => false);
    this.onScrubBegin = opts.onScrubBegin || (() => {});
    this.onScrubTurn = opts.onScrubTurn || (() => {});
    this.onScrubEnd = opts.onScrubEnd || (() => {});
    this.raycaster = new THREE.Raycaster();
    this.tempMatrix = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._ray = new THREE.Raycaster();
    this.controllers = [];
    this.slots = [];
    /** controller currently scrubbing (engaged twist), or null */
    this.scrubController = null;

    const handFactory = new XRHandModelFactory();
    const rayGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -5)
    ]);
    const rayMat = new THREE.LineBasicMaterial({
      color: 0x60a5fa,
      transparent: true,
      opacity: 0.65
    });

    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      const line = new THREE.Line(rayGeo, rayMat);
      controller.add(line);
      scene.add(controller);

      const slot = {
        controller,
        inputSource: null,
        pressed: false,
        armed: false,
        engaged: false,
        gesture: new TwistGesture({ engageDeg: 8 }),
        startRay: new THREE.Raycaster()
      };
      this.slots.push(slot);

      controller.addEventListener('connected', (e) => { slot.inputSource = e.data || null; });
      controller.addEventListener('disconnected', () => {
        this._cancel(slot);
        slot.inputSource = null;
      });
      controller.addEventListener('selectstart', () => this._onSelectStart(slot));
      controller.addEventListener('selectend', () => this._onSelectEnd(slot));

      const hand = renderer.xr.getHand(i);
      hand.add(handFactory.createHandModel(hand, 'mesh'));
      scene.add(hand);

      this.controllers.push(controller);
    }
  }

  _fillRay(controller, ray) {
    this.tempMatrix.identity().extractRotation(controller.matrixWorld);
    this._origin.setFromMatrixPosition(controller.matrixWorld);
    this._dir.set(0, 0, -1).applyMatrix4(this.tempMatrix).normalize();
    ray.set(this._origin, this._dir);
  }

  _onSelectStart(slot) {
    slot.pressed = true;
    slot.engaged = false;
    slot.armed = false;
    this._fillRay(slot.controller, slot.startRay);
    const otherScrubbing = this.scrubController && this.scrubController !== slot.controller;
    if (!otherScrubbing && this.canScrub(slot.startRay)) {
      slot.armed = true;
      slot.controller.getWorldQuaternion(this._q);
      slot.gesture.start(this._q);
      return; // decide on release (select) or engage (scrub)
    }
    if (otherScrubbing) return; // one hand scrubs at a time; ignore the second pinch
    this.onSelectRay(slot.startRay);
  }

  _onSelectEnd(slot) {
    const { armed, engaged } = slot;
    this._cancel(slot);
    if (armed && !engaged) this.onSelectRay(slot.startRay);
  }

  /** Stop tracking a press; ends the scrub if this slot owned it. */
  _cancel(slot) {
    const wasEngaged = slot.engaged;
    slot.pressed = false;
    slot.armed = false;
    slot.engaged = false;
    slot.gesture.end();
    if (wasEngaged && this.scrubController === slot.controller) {
      this.scrubController = null;
      this.onScrubEnd();
    }
  }

  /** Call once per animation frame. */
  update(dt) {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot.armed) continue;
      slot.controller.getWorldQuaternion(this._q);
      const r = slot.gesture.update(this._q, dt);
      if (!r.engaged) continue;
      if (!slot.engaged) {
        if (this.scrubController) continue; // another hand got there first
        slot.engaged = true;
        this.scrubController = slot.controller;
        this.onScrubBegin(slot.controller);
      }
      if (slot.engaged && r.deltaDeg !== 0) this.onScrubTurn(r.deltaDeg, slot.controller);
    }
  }

  /** Haptic pulse on the scrubbing controller (or any given one). intensity 0..1, ms duration. */
  pulse(intensity, ms, controller = this.scrubController) {
    if (!controller) return;
    const slot = this.slots.find((s) => s.controller === controller);
    const gp = slot && slot.inputSource && slot.inputSource.gamepad;
    if (!gp) return;
    try {
      const act = gp.hapticActuators && gp.hapticActuators[0];
      if (act && act.pulse) act.pulse(intensity, ms);
      else if (gp.vibrationActuator && gp.vibrationActuator.playEffect) {
        gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: intensity, weakMagnitude: intensity });
      }
    } catch (e) { /* haptics are best-effort */ }
  }

  hapticTick() { this.pulse(0.25, 12); }
  hapticClick() { this.pulse(1.0, 60); }
}
