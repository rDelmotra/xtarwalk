import * as THREE from 'three';

/**
 * Constellation lines as soft, silvery screen-space ribbons, graded by distance from the view centre.
 *
 * Ribbon technique ("fat lines"): every segment is a quad (4 vertices). All four vertices carry BOTH
 * endpoints (`position` = A, `aB` = B) plus a corner code (x: 0 = A end / 1 = B end, y: side -1/+1,
 * z: random phase). The vertex shader shortens the segment slightly at both ends, projects both
 * endpoints with the per-eye projection*modelView built-ins (so it is stereo-correct in WebXR), works
 * out the segment direction in pixel space and pushes the vertex sideways by the ribbon half-width.
 */

const DEG = 180 / Math.PI;

// ---- gaze weighting curve: angular distance (deg, at a 65 deg vertical FOV) -> weight ----
const CURVE_D = [0, 12, 25, 40, 55, 80];
const CURVE_W = [1, 1, 0.45, 0.18, 0.05, 0];
// monotone cubic (Fritsch-Carlson) tangents so the curve is smooth and never overshoots
const CURVE_M = (() => {
  const n = CURVE_D.length;
  const delta = [];
  for (let i = 0; i < n - 1; i++) delta.push((CURVE_W[i + 1] - CURVE_W[i]) / (CURVE_D[i + 1] - CURVE_D[i]));
  const m = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) m[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
  m[0] = 0;
  m[n - 1] = 0;
  return m;
})();

/** Target weight for an (FOV-normalised) angular distance in degrees. No allocation. */
export function gazeWeight(d) {
  if (!(d < CURVE_D[CURVE_D.length - 1])) return 0;
  let i = 0;
  while (d > CURVE_D[i + 1]) i++;
  const h = CURVE_D[i + 1] - CURVE_D[i];
  const t = (d - CURVE_D[i]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const w =
    (2 * t3 - 3 * t2 + 1) * CURVE_W[i] +
    (t3 - 2 * t2 + t) * h * CURVE_M[i] +
    (-2 * t3 + 3 * t2) * CURVE_W[i + 1] +
    (t3 - t2) * h * CURVE_M[i + 1];
  return w < 0 ? 0 : w > 1 ? 1 : w;
}

const FORM_S = 1.6;   // lines grow out of their stars
const SETTLE_S = 3.5; // then the glow eases down to a quiet residual
const RESET_S = 2.0;  // out of view this long -> forms again next time
const RISE_S = 1.2; // full 0 -> 1 sweep on the eased progress variable
const FALL_S = 1.6;
const FOCUS_DEG = 25; // getFocusedConstellation() limit
const CAP_OTHERS = 0.86; // only the 2 closest constellations may reach >= 0.9
const BASE_FOV = 65;

const smooth = (p) => p * p * (3 - 2 * p);
const invSmooth = (y) => (y <= 0 ? 0 : y >= 1 ? 1 : 0.5 - Math.sin(Math.asin(1 - 2 * y) / 3));

const makeVert = (n) => /* glsl */ `
  attribute vec3 aB;       // other endpoint ( position = endpoint A )
  attribute vec3 aCorner;  // x: 0 = A end, 1 = B end; y: side (-1/+1); z: phase 0..1
  attribute float aConst;
  uniform float uWeights[${n}];
  uniform float uFlare[${n}];
  uniform vec2 uResolution; // viewport size in pixels (per eye)
  uniform float uPx;        // pixel-size multiplier (device pixel ratio / XR boost)
  uniform float uGap;       // end gap in scene units
  varying float vW;
  varying float vFlare;   // envelope: 1 while forming, decays to 0 once formed
  varying float vReveal;  // 0..1 how much of each segment has grown out of its stars
  varying float vAlt;
  varying float vDist;
  varying float vCore;
  varying float vT;
  varying float vPhase;

  void main() {
    int k = int(aConst + 0.5);
    float w = uWeights[k];
    vW = w;
    float packed = uFlare[k];            // floor = reveal*1000, fract = envelope (one uniform slot per constellation)
    vReveal = floor(packed) / 1000.0;
    vFlare = fract(packed);
    vPhase = aCorner.z;
    vDist = 0.0; vCore = 1.0; vT = 0.0; vAlt = 1.0;
    if (w < 0.004) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

    vec3 A = position;
    vec3 B = aB;
    float L = length(B - A);
    float f = min(0.38, uGap / max(L, 1e-4));
    vec3 A2 = mix(A, B, f);
    vec3 B2 = mix(B, A, f);
    vT = mix(f, 1.0 - f, aCorner.x);
    vAlt = normalize((modelMatrix * vec4(mix(A2, B2, aCorner.x), 1.0)).xyz).y; // world space: group may be rotated

    mat4 mvp = projectionMatrix * modelViewMatrix;
    vec4 ca = mvp * vec4(A2, 1.0);
    vec4 cb = mvp * vec4(B2, 1.0);
    const float EPS = 0.05;
    bool offA = ca.w < EPS;
    bool offB = cb.w < EPS;
    if (offA && offB) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    if (offA) { ca = mix(ca, cb, (EPS - ca.w) / (cb.w - ca.w)); }
    if (offB) { cb = mix(cb, ca, (EPS - cb.w) / (ca.w - cb.w)); }

    vec2 half2 = uResolution * 0.5;
    vec2 pa = ca.xy / ca.w * half2;
    vec2 pb = cb.xy / cb.w * half2;
    vec2 d = pb - pa;
    float dl = length(d);
    vec2 dir = dl > 1e-4 ? d / dl : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);

    float width = mix(0.8, 1.35, w) * uPx;        // pixels
    float core = width * 0.5;
    float halfQuad = core * 4.0 + 1.0;
    vCore = core;
    vDist = aCorner.y * halfQuad;

    bool isA = aCorner.x < 0.5;
    vec4 c = isA ? ca : cb;
    vec2 p = isA ? pa : pb;
    p += nrm * vDist;
    gl_Position = vec4(p / half2 * c.w, c.z, c.w);
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uNight;
  uniform float uDayFade;
  uniform float uHorizonClip;
  varying float vW;
  varying float vFlare;
  varying float vReveal;
  varying float vAlt;
  varying float vDist;
  varying float vCore;
  varying float vT;
  varying float vPhase;

  void main() {
    // Draw-on: each segment grows from both of its stars toward its middle.
    float fromStar = min(vT, 1.0 - vT);
    float grown = smoothstep(vReveal * 0.5 + 0.015, vReveal * 0.5 - 0.015, fromStar);
    if (grown <= 0.001) discard;
    float clip = mix(1.0, smoothstep(-0.01, 0.02, vAlt), uHorizonClip);
    float d = abs(vDist) / max(vCore, 0.01);
    float prof = exp(-2.0 * d * d) + 0.22 * exp(-(d * d) / 4.84); // gaussian core + faint wide glow
    // travelling highlight while a constellation is flaring up, slow breathing once settled
    float s = fract(vT * 0.8 - uTime * 0.35 + vPhase);
    float sb = (s - 0.5) / 0.1;
    float bump = exp(-sb * sb);
    float shimmer = vFlare * bump;
    float breath = 1.0 + 0.08 * sin(uTime * 0.8 + vPhase * 6.2832) * (1.0 - vFlare);

    vec3 silver = mix(vec3(0.72, 0.77, 0.84), vec3(0.92, 0.94, 1.0), vW);
    vec3 red = mix(vec3(0.55, 0.08, 0.08), vec3(0.95, 0.28, 0.26), vW);
    vec3 col = mix(silver, red, uNight) + shimmer * 0.12;

    float a = mix(0.02, 0.62, pow(vW, 1.6));
    a *= 0.32 + 0.68 * vFlare;   // forms bright, then settles to a quiet residual
    a *= prof * (1.0 + 0.45 * shimmer) * breath * grown;
    a = min(a, 0.85) * uDayFade * clip;
    gl_FragColor = vec4(col, a);
  }
`;

export class ConstellationLines {
  constructor(catalog, parent) {
    const segs = catalog.lineSegments;
    this._segs = segs;
    this.names = [];
    this.idx = new Map();
    const nSeg = segs.length;
    const aConst = new Float32Array(nSeg * 4);
    const corner = new Float32Array(nSeg * 4 * 3);
    const index = new Uint32Array(nSeg * 6);
    for (let i = 0; i < nSeg; i++) {
      const nm = segs[i].constellation;
      let k = this.idx.get(nm);
      if (k === undefined) {
        k = this.names.length;
        this.idx.set(nm, k);
        this.names.push(nm);
      }
      const phase = (Math.sin(i * 12.9898) * 43758.5453) % 1;
      const ph = phase < 0 ? phase + 1 : phase;
      for (let v = 0; v < 4; v++) {
        aConst[i * 4 + v] = k;
        const o = (i * 4 + v) * 3;
        corner[o] = v >> 1; // 0,0,1,1
        corner[o + 1] = v & 1 ? 1 : -1; // -1,+1,-1,+1
        corner[o + 2] = ph;
      }
      const b = i * 4;
      index.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], i * 6);
    }
    const n = Math.max(1, this.names.length);
    this.n = n;
    this.weights = new Float32Array(n); // displayed (eased) weight
    this._progress = new Float32Array(n); // linear progress; weight = smoothstep(progress)
    this._flare = new Float32Array(n); // packed reveal/envelope sent to the shader
    this._reveal = new Float32Array(n);
    this._env = new Float32Array(n).fill(1);
    this._away = new Float32Array(n);
    this._dist = new Float32Array(n);
    this.centroids = new Float32Array(n * 3);
    this._centroidValid = new Uint8Array(n);
    this._time = 0;
    this._focusIdx = -1;
    this.focusName = null;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nSeg * 4 * 3), 3));
    geo.setAttribute('aB', new THREE.BufferAttribute(new Float32Array(nSeg * 4 * 3), 3));
    geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 3));
    geo.setAttribute('aConst', new THREE.BufferAttribute(aConst, 1));
    geo.setIndex(new THREE.BufferAttribute(index, 1));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uWeights: { value: this.weights },
        uFlare: { value: this._flare },
        uResolution: { value: new THREE.Vector2(1280, 720) },
        uPx: { value: 1 },
        uGap: { value: 0.42 }, // ~0.3 deg at SKY_RADIUS 80
        uTime: { value: 0 },
        uNight: { value: 0 },
        uDayFade: { value: 1 },
        uHorizonClip: { value: 1 }
      },
      vertexShader: makeVert(n),
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    const u = this.material.uniforms;
    this.mesh.onBeforeRender = (renderer, scene, camera) => {
      const cam = camera.isArrayCamera && camera.cameras.length ? camera.cameras[0] : camera;
      if (cam.viewport && renderer.xr.isPresenting) {
        u.uResolution.value.set(cam.viewport.z, cam.viewport.w);
        u.uPx.value = 1.25;
      } else {
        renderer.getDrawingBufferSize(u.uResolution.value);
        u.uPx.value = renderer.getPixelRatio();
      }
      this.material.uniformsNeedUpdate = true;
    };
    parent.add(this.mesh);
  }

  /** Per-segment endpoint positions (6 floats each, celestial-group local). */
  setPositions(lp) {
    const pos = this.mesh.geometry.getAttribute('position');
    const oth = this.mesh.geometry.getAttribute('aB');
    const P = pos.array;
    const Q = oth.array;
    const nSeg = this._segs.length;
    for (let i = 0; i < nSeg; i++) {
      const s = i * 6;
      for (let v = 0; v < 4; v++) {
        const o = (i * 4 + v) * 3;
        P[o] = lp[s]; P[o + 1] = lp[s + 1]; P[o + 2] = lp[s + 2];
        Q[o] = lp[s + 3]; Q[o + 1] = lp[s + 4]; Q[o + 2] = lp[s + 5];
      }
    }
    pos.needsUpdate = true;
    oth.needsUpdate = true;
    this._computeCentroids(lp);
  }

  _computeCentroids(lp) {
    const segs = this._segs;
    const c = this.centroids;
    c.fill(0);
    for (let i = 0; i < segs.length; i++) {
      const k = this.idx.get(segs[i].constellation) * 3;
      const b = i * 6;
      c[k] += lp[b] + lp[b + 3];
      c[k + 1] += lp[b + 1] + lp[b + 4];
      c[k + 2] += lp[b + 2] + lp[b + 5];
    }
    for (let k = 0; k < this.names.length; k++) {
      const o = k * 3;
      const len = Math.hypot(c[o], c[o + 1], c[o + 2]);
      if (len < 1e-6) { this._centroidValid[k] = 0; continue; }
      c[o] /= len; c[o + 1] /= len; c[o + 2] /= len;
      this._centroidValid[k] = 1;
    }
  }

  /**
   * @param dt seconds
   * @param g unit gaze in celestialGroup-local space
   * @param ry world-up row in celestialGroup-local space (horizon test)
   * @param clip horizon clipping on
   * @param enabled Lines toggle
   * @param fovDeg camera vertical FOV
   */
  update(dt, g, ry, clip, enabled, fovDeg) {
    dt = Math.min(Math.max(dt, 0), 0.1);
    this._time += dt;
    const n = this.names.length;
    if (!n) return;
    const c = this.centroids;
    const dist = this._dist;
    const scale = Math.min(1.8, Math.max(0.6, fovDeg / BASE_FOV));
    let b1 = -1;
    let b2 = -1;
    let d1 = Infinity;
    let d2 = Infinity;
    for (let k = 0; k < n; k++) {
      let d = Infinity;
      const o = k * 3;
      if (enabled && this._centroidValid[k] && (!clip || c[o] * ry.x + c[o + 1] * ry.y + c[o + 2] * ry.z > -0.1)) {
        const dot = c[o] * g.x + c[o + 1] * g.y + c[o + 2] * g.z;
        d = (Math.acos(dot > 1 ? 1 : dot < -1 ? -1 : dot) * DEG) / scale;
      }
      dist[k] = d;
      if (d < d1) { d2 = d1; b2 = b1; d1 = d; b1 = k; }
      else if (d < d2) { d2 = d; b2 = k; }
    }
    const focus = b1 >= 0 && d1 * scale < FOCUS_DEG ? b1 : -1;
    if (focus !== this._focusIdx) {
      this._focusIdx = focus;
      this.focusName = focus >= 0 ? this.names[focus] : null;
    }
    const w = this.weights;
    const p = this._progress;
    const fl = this._flare;
    const dUp = dt / RISE_S;
    const dDown = dt / FALL_S;
    const fk = Math.min(1, dt / 0.5);
    for (let k = 0; k < n; k++) {
      let tgt = gazeWeight(dist[k]);
      if (k !== b1 && k !== b2 && tgt > CAP_OTHERS) tgt = CAP_OTHERS;
      const pt = invSmooth(tgt);
      const cur = p[k];
      const rising = pt > cur + 0.02 && tgt > 0.1;
      if (pt > cur) p[k] = Math.min(pt, cur + dUp);
      else p[k] = Math.max(pt, cur - dDown);
      w[k] = smooth(p[k]);
      // Life cycle: when a constellation comes into view it FORMS (lines grow out of the stars while a
      // soft highlight runs along them), then settles to a quiet residual. Out of view for a while ->
      // it will form again next time.
      const rv = this._reveal, env = this._env, away = this._away;
      if (tgt > 0.12) {
        away[k] = 0;
        if (rv[k] < 1) { rv[k] = Math.min(1, rv[k] + dt / FORM_S); env[k] = 1; }
        else env[k] = Math.max(0, env[k] - dt / SETTLE_S);
      } else if (tgt < 0.08) {
        away[k] += dt;
        if (away[k] > RESET_S) { rv[k] = 0; env[k] = 1; }
      }
      fl[k] = Math.round(rv[k] * 1000) + Math.min(0.999, env[k]);
      void rising; void fk;
    }
    const u = this.material.uniforms;
    u.uTime.value = this._time;
    this.material.uniformsNeedUpdate = true;
  }

  setNightMode(on) {
    this.material.uniforms.uNight.value = on ? 1 : 0;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
