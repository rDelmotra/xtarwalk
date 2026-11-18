import * as THREE from 'three';

/**
 * In-view hint for the push-to-align gesture: two ghostly open-palm outlines that push outward
 * along the gaze, plus a text line. Shown when the user looks up (pitch > 25 deg held ~1 s) and
 * the sky is uncalibrated this session (or >= 3 min stale). Auto-hides after 8 s; re-arms once
 * the user looks back down. flash(text) shows a transient message (results / errors).
 */
const LOOK_UP_DEG = 25;
const REARM_DEG = 15;
const HOLD_S = 1.0;
const SHOW_S = 8;
const STALE_S = 180;
const CYCLE_S = 2.2;
const SILVER = 0xb8c6e6;

function makeTextPlane(width) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 128;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, opacity: 0 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, width * 0.125), mat);
  mesh.renderOrder = 999;
  mesh.userData.canvas = canvas;
  mesh.userData.text = null;
  return mesh;
}

function drawText(mesh, text) {
  if (mesh.userData.text === text) return;
  mesh.userData.text = text;
  const c = mesh.userData.canvas;
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.font = '600 44px system-ui, -apple-system, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(120,150,255,0.8)';
  g.shadowBlur = 14;
  g.fillStyle = '#e8eefc';
  g.fillText(text, c.width / 2, c.height / 2, c.width - 40);
  mesh.material.map.needsUpdate = true;
}

/** Palm outline + 4 fingers + thumb as LineSegments; `open` (0..1) fans/extends the fingers. */
class PalmOutline {
  constructor(side) {
    this.side = side; // -1 left, +1 right (mirrors the thumb)
    this.positions = new Float32Array(64 * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.mat = new THREE.LineBasicMaterial({
      color: SILVER, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false
    });
    this.lines = new THREE.LineSegments(this.geo, this.mat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 998;
    this.setOpen(1);
  }

  setOpen(open) {
    const p = [];
    const seg = (ax, ay, bx, by) => p.push(ax, ay, 0, bx, by, 0);
    // palm: rounded-ish hexagon, ~8 cm wide, 9 cm tall (metres)
    const pts = [[-0.04, -0.045], [0.04, -0.045], [0.045, 0.0], [0.04, 0.045], [-0.04, 0.045], [-0.045, 0.0]];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      seg(a[0], a[1], b[0], b[1]);
    }
    // four fingers: curled (short, converging) -> open (long, slightly fanned)
    const xs = [-0.03, -0.01, 0.01, 0.03];
    const lens = [0.07, 0.085, 0.08, 0.06];
    const fan = [-0.16, -0.05, 0.05, 0.16];
    for (let i = 0; i < 4; i++) {
      const L = lens[i] * (0.45 + 0.55 * open);
      const ang = fan[i] * open;
      seg(xs[i], 0.045, xs[i] + Math.sin(ang) * L, 0.045 + Math.cos(ang) * L);
    }
    // thumb
    const s = this.side;
    const ta = (0.9 + 0.2 * (1 - open)) * -s;
    seg(s * 0.042, -0.02, s * 0.042 - Math.sin(ta) * 0.06, -0.02 + Math.cos(ta) * 0.06 * 0.9);
    this.positions.fill(0);
    this.positions.set(p);
    this.geo.setDrawRange(0, p.length / 3);
    this.geo.attributes.position.needsUpdate = true;
  }

  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

export class PushHint {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.palms = [new PalmOutline(-1), new PalmOutline(1)];
    this.palmGroups = this.palms.map((p) => { const g = new THREE.Group(); g.add(p.lines); this.group.add(g); return g; });
    this.text = makeTextPlane(0.9);
    this.text.position.set(0, -0.2, 0);
    this.group.add(this.text);
    scene.add(this.group);

    this.clock = 0;
    this.lastCalAt = -Infinity;
    this.lookUpS = 0;
    this.showS = 0;
    this.armed = true;
    this.flashS = 0;
    this.flashText = '';
    this.fade = 0;
    this._fwd = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._placed = false;
    this.mode = 'idle'; // 'idle' | 'hint' | 'flash'
  }

  /** Fresh XR session: needs calibration again, nothing showing. */
  reset() {
    this.lastCalAt = -Infinity;
    this.lookUpS = 0; this.showS = 0; this.flashS = 0;
    this.armed = true; this.mode = 'idle'; this.fade = 0; this._placed = false;
    this.group.visible = false;
  }

  /** A successful alignment happened: hide the hint and start the 3 min staleness timer. */
  markCalibrated() {
    this.lastCalAt = this.clock;
    this.showS = 0;
    if (this.mode === 'hint') this.mode = 'idle';
  }

  get needsCalibration() { return this.clock - this.lastCalAt >= STALE_S; }

  /** Show a transient message in view (errors / results). */
  flash(text, seconds = 3) {
    this.flashText = text;
    this.flashS = seconds;
    this.mode = 'flash';
    this._placed = false;
  }

  /**
   * @param {number} dt
   * @param {THREE.Object3D} head XR camera
   * @param {{enabled:boolean, label?:string}} o enabled = in XR and not busy; label = brightest candidate name
   */
  update(dt, head, o) {
    this.clock += dt;
    const fwd = this._fwd.set(0, 0, -1).applyQuaternion(head.quaternion);
    const pitchDeg = Math.asin(Math.max(-1, Math.min(1, fwd.y))) * 180 / Math.PI;

    if (!o.enabled) {
      this.lookUpS = 0;
      if (this.mode === 'hint') this.mode = 'idle';
    } else {
      if (pitchDeg < REARM_DEG) this.armed = true;
      if (this.mode === 'idle' && this.armed && this.needsCalibration && pitchDeg > LOOK_UP_DEG) {
        this.lookUpS += dt;
        if (this.lookUpS >= HOLD_S) {
          this.mode = 'hint'; this.showS = SHOW_S; this.armed = false; this.lookUpS = 0; this._placed = false;
        }
      } else if (pitchDeg <= LOOK_UP_DEG) this.lookUpS = 0;
    }

    if (this.mode === 'hint') {
      this.showS -= dt;
      if (this.showS <= 0) this.mode = 'idle';
    } else if (this.mode === 'flash') {
      this.flashS -= dt;
      if (this.flashS <= 0) this.mode = 'idle';
    }

    const want = this.mode === 'idle' ? 0 : 1;
    this.fade += (want - this.fade) * Math.min(1, dt * 6);
    if (this.fade < 0.01 && want === 0) { this.group.visible = false; return; }
    this.group.visible = true;

    // float ~1 m ahead of the gaze, facing the head; snap on first placement then ease
    this._target.copy(head.position).addScaledVector(fwd, 1.0);
    if (!this._placed) { this.group.position.copy(this._target); this._placed = true; }
    else this.group.position.lerp(this._target, Math.min(1, dt * 4));
    this.group.lookAt(head.position);

    const showPalms = this.mode === 'hint';
    const label = o.label || 'the brightest star';
    const text = this.mode === 'flash'
      ? this.flashText
      : (label === 'Moon' ? 'Push your palms toward the Moon (or the brightest star)' : `Push your palms toward ${label} (or the brightest object)`);
    drawText(this.text, text);
    this.text.material.opacity = this.fade;
    this.text.position.y = showPalms ? -0.2 : 0;

    for (let i = 0; i < 2; i++) {
      const ph = ((this.clock / CYCLE_S) + 0.0) % 1;
      const env = Math.sin(Math.PI * ph); // fade in/out each push
      const g = this.palmGroups[i];
      g.visible = showPalms;
      g.position.set((i === 0 ? -1 : 1) * 0.16, 0.04, -0.4 * ph); // -z = away from the viewer = toward the sky
      g.scale.setScalar(1.0 + 0.15 * ph);
      this.palms[i].mat.opacity = this.fade * 0.85 * env;
      this.palms[i].setOpen(Math.min(1, 0.15 + ph * 1.4)); // starts half-closed, ends flat
    }
  }

  dispose() {
    this.scene.remove(this.group);
    for (const p of this.palms) p.dispose();
    this.text.geometry.dispose();
    this.text.material.map.dispose();
    this.text.material.dispose();
  }
}
