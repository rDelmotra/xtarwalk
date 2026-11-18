import * as THREE from 'three';

const ARROW_DIST = 1.2;       // metres in front of the viewer
const ARROW_DROP = 0.28;      // below eye level
const NEAR_DEG = 20;          // inside this the arrow is replaced by the reticle
const NEAR_EXIT_DEG = 24;     // hysteresis: leave reticle mode beyond this
const FOUND_DEG = 3;
const FOUND_HOLD_S = 2;
const RETICLE_DIST = 78;
const RAD2DEG = 180 / Math.PI;

const COLORS = {
  day: { arrow: 0x8fe3f5, glow: 0x5fb8d0, ring: 0x8fe3f5, text: '#dbe7f3', border: 'rgba(143,227,245,0.42)', bg: 'rgba(7,12,24,0.78)' },
  night: { arrow: 0xf87171, glow: 0xdc2626, ring: 0xf87171, text: '#fecaca', border: 'rgba(239,68,68,0.8)', bg: 'rgba(28,6,6,0.82)' }
};

/**
 * Wayfinding arrow + target reticle for "Find" mode.
 * The arrow floats in front of the camera and rotates in the view plane toward the target;
 * once the target is near the view centre it is replaced by a pulsing ring in the sky.
 */
export class Wayfinder {
  constructor(scene) {
    this.scene = scene;
    this.target = null;
    this.targetName = null;
    this.onFound = null; // (targetName) => void, fired once after holding within FOUND_DEG
    this.reticleMode = false;
    this.foundTimer = 0;
    this.foundFired = false;
    this.time = 0;
    this.lastText = '';
    this.lastNight = null;

    // Reused scratch objects (no per-frame allocation).
    this._dir = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._local = new THREE.Vector3();
    this._qInv = new THREE.Quaternion();
    this._skyQ = new THREE.Quaternion();

    // ---- Arrow ----
    const head = new THREE.Shape();
    head.moveTo(0.2, 0);
    head.lineTo(0.04, 0.1);
    head.lineTo(0.04, -0.1);
    head.closePath();
    this.headGeo = new THREE.ShapeGeometry(head);
    this.stemGeo = new THREE.PlaneGeometry(0.2, 0.045);
    this.stemGeo.translate(-0.06, 0, 0);

    const mk = (color, opacity) => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthTest: false, depthWrite: false, side: THREE.DoubleSide
    });
    this.arrowMat = mk(COLORS.day.arrow, 0.95);
    this.glowMat = mk(COLORS.day.glow, 0.28);

    this.pivot = new THREE.Group();
    const head1 = new THREE.Mesh(this.headGeo, this.arrowMat);
    const stem1 = new THREE.Mesh(this.stemGeo, this.arrowMat);
    const glowHead = new THREE.Mesh(this.headGeo, this.glowMat);
    const glowStem = new THREE.Mesh(this.stemGeo, this.glowMat);
    glowHead.scale.setScalar(1.4);
    glowStem.scale.set(1.2, 2.2, 1);
    for (const m of [glowHead, glowStem, head1, stem1]) {
      m.renderOrder = m === glowHead || m === glowStem ? 29 : 30;
      this.pivot.add(m);
    }

    // ---- Label (canvas texture, labels.js style) ----
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 96;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.labelMat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false });
    this.labelGeo = new THREE.PlaneGeometry(0.4, 0.075);
    this.label = new THREE.Mesh(this.labelGeo, this.labelMat);
    this.label.position.set(0, -0.17, 0);
    this.label.renderOrder = 31;

    this.arrowGroup = new THREE.Group();
    this.arrowGroup.add(this.pivot, this.label);
    this.arrowGroup.visible = false;
    this.scene.add(this.arrowGroup);

    // ---- Reticle ring in the sky ----
    this.ringGeo = new THREE.RingGeometry(0.88, 1, 64);
    this.ringMat = mk(COLORS.day.ring, 0.9);
    this.ring = new THREE.Mesh(this.ringGeo, this.ringMat);
    this.ring.renderOrder = 28;
    this.ring.visible = false;
    this.scene.add(this.ring);
  }

  setTarget(target) {
    if (!target) {
      this.target = null;
      this.targetName = null;
      this.arrowGroup.visible = false;
      this.ring.visible = false;
      this.reticleMode = false;
      this.foundTimer = 0;
      this.foundFired = false;
      return;
    }
    if (target.name !== this.targetName) {
      this.targetName = target.name;
      this.reticleMode = false;
      this.foundTimer = 0;
      this.foundFired = false;
      this.lastText = '';
    }
    this.target = target; // always refresh the position reference
  }

  _applyTheme(night) {
    if (night === this.lastNight) return;
    this.lastNight = night;
    const c = night ? COLORS.night : COLORS.day;
    this.arrowMat.color.setHex(c.arrow);
    this.glowMat.color.setHex(c.glow);
    this.ringMat.color.setHex(c.ring);
    this.lastText = ''; // force label redraw in the new colours
  }

  _drawLabel(text, night) {
    if (text === this.lastText) return;
    this.lastText = text;
    const c = night ? COLORS.night : COLORS.day;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = c.bg;
    ctx.beginPath();
    ctx.roundRect(3, 3, w - 6, h - 6, 22);
    ctx.fill();
    ctx.strokeStyle = c.border;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.fillStyle = c.text;
    let px = 44;
    do {
      ctx.font = `600 ${px}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      px -= 2;
    } while (ctx.measureText(text).width > w - 40 && px > 16);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2 + 2);
    this.texture.needsUpdate = true;
  }

  update(dt, camera, skyRoot, nightMode) {
    const t = this.target;
    if (!t) return;
    this.time += dt;
    this._applyTheme(nightMode);

    // Target world direction = skyRoot-local pos rotated by skyRoot's world quaternion.
    skyRoot.getWorldQuaternion(this._skyQ);
    const dir = this._dir.set(t.pos.x, t.pos.y, t.pos.z).normalize().applyQuaternion(this._skyQ);
    const fwd = this._fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const angleDeg = Math.acos(Math.max(-1, Math.min(1, fwd.dot(dir)))) * RAD2DEG;

    // Hysteresis between arrow and reticle.
    if (this.reticleMode) {
      if (angleDeg > NEAR_EXIT_DEG) this.reticleMode = false;
    } else if (angleDeg < NEAR_DEG) {
      this.reticleMode = true;
    }

    const pulse = 0.5 + 0.5 * Math.sin(this.time * 4);

    if (angleDeg < FOUND_DEG) {
      this.foundTimer += dt;
      if (this.foundTimer >= FOUND_HOLD_S && !this.foundFired) {
        this.foundFired = true;
        if (this.onFound) this.onFound(this.targetName);
        if (!this.target) return;
      }
    } else {
      this.foundTimer = 0;
    }
    const found = angleDeg < FOUND_DEG;

    // Camera-facing frame for the arrow group.
    this.arrowGroup.quaternion.copy(camera.quaternion);
    this._local.set(0, -ARROW_DROP, -ARROW_DIST).applyQuaternion(camera.quaternion);
    this.arrowGroup.position.copy(camera.position).add(this._local);

    if (!this.reticleMode) {
      // Direction to target expressed in camera space; angle in the view plane (x right, y up).
      this._qInv.copy(camera.quaternion).invert();
      const l = this._local.copy(dir).applyQuaternion(this._qInv);
      this.pivot.rotation.z = Math.atan2(l.y, l.x);
      this.pivot.visible = true;
      this.pivot.scale.setScalar(1 + 0.07 * pulse);
      this.arrowMat.opacity = 0.7 + 0.3 * pulse;
      this.glowMat.opacity = 0.15 + 0.2 * pulse;
      this.label.visible = true;
      this._drawLabel(`${this.targetName} → ${Math.round(angleDeg)}°`, nightMode);
      this.arrowGroup.visible = true;
      this.ring.visible = false;
    } else {
      this.pivot.visible = false;
      if (found) {
        this.label.visible = true;
        this._drawLabel(`Found ${this.targetName} ✓`, nightMode);
        this.arrowGroup.visible = true;
      } else {
        this.arrowGroup.visible = false;
      }
      // Reticle at the target, facing the camera, constant angular size, pulsing.
      this.ring.visible = true;
      this.ring.position.copy(camera.position).addScaledVector(dir, RETICLE_DIST);
      this.ring.quaternion.copy(camera.quaternion);
      this.ring.scale.setScalar(RETICLE_DIST * 0.05 * (1 + 0.25 * pulse));
      this.ringMat.opacity = 0.5 + 0.5 * pulse;
    }
  }

  dispose() {
    this.scene.remove(this.arrowGroup);
    this.scene.remove(this.ring);
    this.headGeo.dispose();
    this.stemGeo.dispose();
    this.labelGeo.dispose();
    this.ringGeo.dispose();
    this.arrowMat.dispose();
    this.glowMat.dispose();
    this.ringMat.dispose();
    this.labelMat.dispose();
    this.texture.dispose();
  }
}
