// Pure math: fit a rotation R (quaternion {x,y,z,w}, three.js v' = q v q*) mapping skyRoot-local
// directions s_i onto observed world directions w_i. Frame: +Y up, +X East, -Z North.
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const nrm = (v) => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Rotate vector v by unit quaternion q. */
export function quatRotate(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + q.y * tz - q.z * ty,
    y: v.y + q.w * ty + q.z * tx - q.x * tz,
    z: v.z + q.w * tz + q.x * ty - q.y * tx
  };
}
/** Hamilton product a*b (apply b first, then a). */
export function quatMul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  };
}
/** Quaternion for a rotation of `rad` about `axis` (need not be unit). */
export function quatFromAxisAngle(axis, rad) {
  const a = nrm(axis), s = Math.sin(rad / 2);
  return { x: a.x * s, y: a.y * s, z: a.z * s, w: Math.cos(rad / 2) };
}
/** Angle in degrees between two directions. */
export function angleDeg(a, b) {
  const A = nrm(a), B = nrm(b);
  const cx = A.y * B.z - A.z * B.y, cy = A.z * B.x - A.x * B.z, cz = A.x * B.y - A.y * B.x;
  return Math.atan2(Math.hypot(cx, cy, cz), dot(A, B)) * R2D;
}
/** Twist (rotation angle) about +Y of q, radians in (-pi, pi]. */
export function yawOf(q) {
  const a = 2 * Math.atan2(q.y, q.w);
  return Math.atan2(Math.sin(a), Math.cos(a));
}
/** Angle in degrees between R*(0,1,0) and (0,1,0). */
export function tiltDegOf(q) {
  return angleDeg(quatRotate(q, { x: 0, y: 1, z: 0 }), { x: 0, y: 1, z: 0 });
}

// Cyclic Jacobi eigen-decomposition of symmetric n x n matrix; returns {vals, vecs (columns)}.
function jacobi(A, n = 4) {
  const a = A.map((r) => r.slice());
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < 1e-30) break;
    for (let p = 0; p < n - 1; p++) for (let r = p + 1; r < n; r++) {
      if (Math.abs(a[p][r]) < 1e-300) continue;
      const th = (a[r][r] - a[p][p]) / (2 * a[p][r]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const x = a[k][p], y = a[k][r]; a[k][p] = c * x - s * y; a[k][r] = s * x + c * y; }
      for (let k = 0; k < n; k++) { const x = a[p][k], y = a[r][k]; a[p][k] = c * x - s * y; a[r][k] = s * x + c * y; }
      for (let k = 0; k < n; k++) { const x = V[k][p], y = V[k][r]; V[k][p] = c * x - s * y; V[k][r] = s * x + c * y; }
    }
  }
  return { vals: a.map((r, i) => r[i]), vecs: V };
}

const prep = (pairs) => pairs.map((p) => ({ s: nrm(p.s), w: nrm(p.w), weight: p.weight ?? 1 }));

function fullFit(P) {
  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
  for (const { s, w, weight: k } of P) {
    Sxx += k * s.x * w.x; Sxy += k * s.x * w.y; Sxz += k * s.x * w.z;
    Syx += k * s.y * w.x; Syy += k * s.y * w.y; Syz += k * s.y * w.z;
    Szx += k * s.z * w.x; Szy += k * s.z * w.y; Szz += k * s.z * w.z;
  }
  // Horn's N matrix, order (w, x, y, z)
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz]
  ];
  const { vals, vecs } = jacobi(N);
  let m = 0;
  for (let i = 1; i < 4; i++) if (vals[i] > vals[m]) m = i;
  const e = [vecs[0][m], vecs[1][m], vecs[2][m], vecs[3][m]];
  const l = Math.hypot(...e) || 1;
  const sg = e[0] < 0 ? -1 : 1;
  return { x: sg * e[1] / l, y: sg * e[2] / l, z: sg * e[3] / l, w: sg * e[0] / l };
}

function yawFit(P) {
  let sx = 0, sy = 0;
  for (const { s, w, weight: k } of P) {
    const d = Math.atan2(s.x, -s.z) - Math.atan2(w.x, -w.z);
    const m = k * Math.hypot(w.x, w.z); // near-zenith azimuths are unreliable
    sx += m * Math.cos(d); sy += m * Math.sin(d);
  }
  return quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.atan2(sy, sx));
}

function residuals(q, P) {
  return P.map(({ s, w }) => angleDeg(quatRotate(q, s), w));
}
function rms(res, P) {
  let a = 0, b = 0;
  res.forEach((r, i) => { a += P[i].weight * r * r; b += P[i].weight; });
  return b > 0 ? Math.sqrt(a / b) : 0;
}

/**
 * Fit rotation mapping s_i -> w_i. One pair: yaw-only. 2+: full 3-axis, falling back to
 * yaw-only if the fit tilts +Y by more than maxTiltDeg.
 * @param {{s:{x,y,z}, w:{x,y,z}, weight?:number}[]} pairs
 * @param {{maxTiltDeg?:number}} [opts]
 * @returns {{q:{x,y,z,w}, rmsDeg:number, residuals:number[]}}
 */
export function fitRotation(pairs, { maxTiltDeg = 3 } = {}) {
  if (!pairs.length) return { q: { x: 0, y: 0, z: 0, w: 1 }, rmsDeg: 0, residuals: [] };
  const P = prep(pairs);
  let q = P.length >= 2 ? fullFit(P) : yawFit(P);
  if (P.length >= 2 && tiltDegOf(q) > maxTiltDeg) q = yawFit(P);
  const res = residuals(q, P);
  return { q, rmsDeg: rms(res, P), residuals: res };
}

/** Accumulates tap observations, refits, and rejects outliers. */
export class RefineSession {
  /** @param {{maxPairs?:number, outlierDeg?:number, maxTiltDeg?:number}} [o] */
  constructor({ maxPairs = 8, outlierDeg = 4, maxTiltDeg = 3 } = {}) {
    Object.assign(this, { maxPairs, outlierDeg, maxTiltDeg });
    this.pairs = []; this._result = null;
  }
  /** Add an observation; returns {q, rmsDeg, used, rejected}. */
  add(s, w, weight = 1) {
    const pair = { s: nrm(s), w: nrm(w), weight };
    const dup = this.pairs.findIndex((p) => angleDeg(p.s, pair.s) < 2);
    if (dup >= 0) this.pairs.splice(dup, 1);
    this.pairs.push(pair);
    while (this.pairs.length > this.maxPairs) this.pairs.shift();
    let fit = fitRotation(this.pairs, this);
    let rejected = false;
    while (this.pairs.length > 2) {
      let worst = 0;
      fit.residuals.forEach((r, i) => { if (r > fit.residuals[worst]) worst = i; });
      if (fit.residuals[worst] <= this.outlierDeg) break;
      if (this.pairs[worst] === pair) rejected = true;
      this.pairs.splice(worst, 1);
      fit = fitRotation(this.pairs, this);
    }
    this._result = { q: fit.q, rmsDeg: fit.rmsDeg };
    return { ...this._result, used: this.pairs.length, rejected };
  }
  reset() { this.pairs = []; this._result = null; }
  get count() { return this.pairs.length; }
  get result() { return this._result; }
}
