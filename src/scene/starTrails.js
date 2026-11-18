import * as THREE from 'three';

/**
 * Long-exposure star trails while the time dial turns. One LineSegments, no render targets (stereo safe).
 * Lives as a child of skyRoot (NOT celestialGroup): the vertex shader rotates each star's base position
 * (the snapshot-frame position) about the celestial pole by an angle that is RELATIVE TO THE CURRENT
 * SNAPSHOT DATE:  angle(t) = -(t - snapMs)/1h * 15.04107 deg,  mix(uAngleTail, uAngleHead, s).
 * Head angle == the live celestialGroup rotation, so the head sits on the star. History is kept in
 * absolute ms, so a snapshot refresh (scrub end) just changes snapMs and the arc stays put.
 */
const SEGMENTS = 24;
const MAX_STARS = 1000;
const MAG_LIMIT = 4.5;
const SIDEREAL_DEG_PER_HOUR = 15.04107;
const DEG2RAD = Math.PI / 180;
const HISTORY_S = 1.2; // wall-clock seconds of shown-time history kept
const TAIL_S = 1.0; // tail = shown time this many wall seconds ago
const MAX_SPAN_MS = 6 * 3.6e6; // cap arc at 6 hours of shown time
const IDLE_AFTER_S = 0.12; // no feed for this long => scrub considered stopped
const FADE_OUT_S = 0.8;
const FADE_IN_S = 0.12;
const CATCHUP_TAU_S = 0.25;

const TRAIL_VERT = /* glsl */ `
  attribute float aT;
  attribute vec3 aColor;
  attribute float aMag;
  uniform float uMagLimit;
  uniform vec3 uPole;
  uniform float uAngleTail;
  uniform float uAngleHead;
  uniform float uDayFade;
  uniform float uHorizonClip;
  uniform float uTrailOpacity;
  uniform float uNightMode;
  varying vec4 vCol;
  vec3 rodrigues(vec3 v, vec3 k, float a) {
    float c = cos(a), s = sin(a);
    return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
  }
  void main() {
    float a = mix(uAngleTail, uAngleHead, aT);
    vec3 p = rodrigues(position, normalize(uPole), a);
    float alt = normalize((modelMatrix * vec4(p, 1.0)).xyz).y;
    float clip = mix(1.0, smoothstep(-0.01, 0.02, alt), uHorizonClip);
    float lum = pow(10.0, -0.2 * aMag);
    float bright = clamp(0.18 + 0.7 * lum, 0.0, 1.0);
    float fade = pow(aT, 1.6); // 0 at tail -> 1 at head (comet look)
    vec3 col = mix(aColor, vec3(1.0), 0.45);
    float l = dot(col, vec3(0.3, 0.59, 0.11));
    col = mix(col, vec3(1.0, 0.22, 0.18) * l * 1.2, uNightMode);
    float vis = smoothstep(uMagLimit + 0.35, uMagLimit - 0.35, aMag);
    vCol = vec4(col, 0.85 * fade * bright * uDayFade * clip * uTrailOpacity * vis);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const TRAIL_FRAG = /* glsl */ `
  varying vec4 vCol;
  void main() { gl_FragColor = vCol; }
`;

export class StarTrails {
  /** @param {Array<{mag:number, rgb:number[]}>} stars catalog.stars */
  constructor(stars) {
    const idx = [];
    for (let i = 0; i < stars.length; i++) if (stars[i].mag <= MAG_LIMIT) idx.push(i);
    idx.sort((a, b) => stars[a].mag - stars[b].mag);
    if (idx.length > MAX_STARS) idx.length = MAX_STARS;
    this._idx = idx;
    const n = idx.length;
    const vcount = n * SEGMENTS * 2;
    const t = new Float32Array(vcount);
    const col = new Float32Array(vcount * 3);
    const mag = new Float32Array(vcount);
    let v = 0;
    for (let k = 0; k < n; k++) {
      const s = stars[idx[k]];
      for (let j = 0; j < SEGMENTS; j++) {
        for (let e = 0; e < 2; e++, v++) {
          t[v] = (j + e) / SEGMENTS;
          col[v * 3] = s.rgb[0];
          col[v * 3 + 1] = s.rgb[1];
          col[v * 3 + 2] = s.rgb[2];
          mag[v] = s.mag;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vcount * 3), 3));
    geo.setAttribute('aT', new THREE.BufferAttribute(t, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPole: { value: new THREE.Vector3(0, 0, -1) },
        uAngleTail: { value: 0 },
        uAngleHead: { value: 0 },
        uDayFade: { value: 1 },
        uMagLimit: { value: 6.5 },
        uHorizonClip: { value: 1 },
        uTrailOpacity: { value: 0 },
        uNightMode: { value: 0 }
      },
      vertexShader: TRAIL_VERT,
      fragmentShader: TRAIL_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.object = new THREE.LineSegments(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 1;
    this.object.visible = false;

    this._snapMs = null;
    this._hist = []; // {w: wall seconds, t: shown ms}
    this._wall = 0;
    this._lastFeedWall = -Infinity;
    this._headMs = 0;
    this._tailMs = 0;
    this._opacity = 0;
    this._dirtyPos = true;
    this._basePos = null;
  }

  setPole(p) { this.material.uniforms.uPole.value.copy(p).normalize(); }

  /** New exact snapshot: base positions (unrotated frame) + its date. */
  setSnapshot(starPositions, snapMs) {
    if (Number.isFinite(snapMs)) this._snapMs = snapMs;
    const pos = this.object.geometry.getAttribute('position');
    const arr = pos.array;
    let v = 0;
    for (let k = 0; k < this._idx.length; k++) {
      const i = this._idx[k] * 3;
      const x = starPositions[i], y = starPositions[i + 1], z = starPositions[i + 2];
      for (let j = 0; j < SEGMENTS * 2; j++, v++) {
        arr[v * 3] = x;
        arr[v * 3 + 1] = y;
        arr[v * 3 + 2] = z;
      }
    }
    pos.needsUpdate = true;
    this._applyAngles();
  }

  /** Called every frame the dial shows a time. snapMs = shown time - deltaHours (snapshot time). */
  feed(shownMs, snapMs) {
    if (Number.isFinite(snapMs)) this._snapMs = snapMs;
    const w = this._wall;
    this._lastFeedWall = w;
    const h = this._hist;
    h.push({ w, t: shownMs });
    while (h.length > 1 && h[0].w < w - HISTORY_S) h.shift();
    // tail = oldest sample within the last TAIL_S (interpolate would be overkill at 72 Hz)
    let tail = h[h.length - 1].t;
    for (let i = 0; i < h.length; i++) {
      if (h[i].w >= w - TAIL_S) { tail = h[i].t; break; }
    }
    this._headMs = shownMs;
    this._tailMs = Math.abs(shownMs - tail) > MAX_SPAN_MS ? shownMs - Math.sign(shownMs - tail) * MAX_SPAN_MS : tail;
    this._applyAngles();
  }

  _applyAngles() {
    if (this._snapMs === null) return;
    const k = -(SIDEREAL_DEG_PER_HOUR * DEG2RAD) / 3.6e6;
    const u = this.material.uniforms;
    u.uAngleHead.value = (this._headMs - this._snapMs) * k;
    u.uAngleTail.value = (this._tailMs - this._snapMs) * k;
  }

  /** Per frame; cheap no-op while idle. */
  update(dt) {
    this._wall += dt;
    const scrubbing = this._wall - this._lastFeedWall <= IDLE_AFTER_S;
    if (!scrubbing && this._opacity <= 0) {
      if (this.object.visible) this.object.visible = false;
      return;
    }
    if (scrubbing) {
      this._opacity = Math.min(1, this._opacity + dt / FADE_IN_S);
    } else {
      this._opacity = Math.max(0, this._opacity - dt / FADE_OUT_S);
      // tail catches up to head
      this._tailMs += (this._headMs - this._tailMs) * (1 - Math.exp(-dt / CATCHUP_TAU_S));
      this._applyAngles();
      if (this._opacity <= 0) this._hist.length = 0;
    }
    this.material.uniforms.uTrailOpacity.value = this._opacity;
    this.object.visible = this._opacity > 0.002;
  }

  setDayFade(f) { this.material.uniforms.uDayFade.value = f; }
  setMagLimit(m) { this.material.uniforms.uMagLimit.value = m; }
  setHorizonClip(on) { this.material.uniforms.uHorizonClip.value = on ? 1 : 0; }
  setNightMode(on) { this.material.uniforms.uNightMode.value = on ? 1 : 0; }

  dispose() {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
