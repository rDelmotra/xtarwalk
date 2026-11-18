// Wrist-twist detector: swing-twist decomposition of an orientation relative to the
// orientation at gesture start, twist about the START pointing axis (local -Z).
// Positive deltaDeg = clockwise as seen by the user (looking along the ray).
// Allocation-free: quaternions are passed as {x,y,z,w}-like objects and read as scalars.

const RAD2DEG = 180 / Math.PI;

function wrap180(a) {
  a = (a + 180) % 360;
  if (a < 0) a += 360;
  return a - 180;
}

export class TwistGesture {
  /** @param {{engageDeg?: number, smoothSeconds?: number}} opts */
  constructor({ engageDeg = 8, smoothSeconds = 0.04 } = {}) {
    this.engageDeg = engageDeg;
    this.smoothSeconds = smoothSeconds;
    this.active = false;
    this.engaged = false;
    this.result = { engaged: false, deltaDeg: 0 }; // reused each update (no allocation)
    this.totalDeg = 0; // filtered, unwrapped twist since start
    this._sx = 0; this._sy = 0; this._sz = 0; this._sw = 1;
    this._rawPrev = 0;
    this._raw = 0;
    this._filtered = 0;
    this._lastReported = 0;
  }

  start(q) {
    this._sx = q.x; this._sy = q.y; this._sz = q.z; this._sw = q.w;
    this.active = true;
    this.engaged = false;
    this._rawPrev = 0;
    this._raw = 0;
    this._filtered = 0;
    this._lastReported = 0;
    this.totalDeg = 0;
    this.result.engaged = false;
    this.result.deltaDeg = 0;
  }

  end() {
    this.active = false;
    this.engaged = false;
    this.result.engaged = false;
    this.result.deltaDeg = 0;
  }

  /** Raw twist angle (deg, wrapped to ±180) of `q` about the start pointing axis. */
  _twistOf(q) {
    const sx = this._sx, sy = this._sy, sz = this._sz, sw = this._sw;
    // rel = conj(start) * q ; we need rel.z and rel.w only
    const rz = sw * q.z - sz * q.w - sx * q.y + sy * q.x;
    const rw = sw * q.w + sx * q.x + sy * q.y + sz * q.z;
    // axis = (0,0,-1): projection of vector part onto axis = -rz
    return wrap180(2 * Math.atan2(-rz, rw) * RAD2DEG);
  }

  /**
   * @param {{x:number,y:number,z:number,w:number}} q current orientation
   * @param {number} dt seconds since last update (for the low-pass)
   * @returns {{engaged:boolean, deltaDeg:number}} (same object every call)
   */
  update(q, dt = 1 / 72) {
    const res = this.result;
    if (!this.active) { res.engaged = false; res.deltaDeg = 0; return res; }
    const raw = this._twistOf(q);
    this._raw += wrap180(raw - this._rawPrev); // unwrap across ±180
    this._rawPrev = raw;
    const a = this.smoothSeconds > 0 ? 1 - Math.exp(-dt / this.smoothSeconds) : 1;
    this._filtered += (this._raw - this._filtered) * a;
    this.totalDeg = this._filtered;

    if (!this.engaged) {
      if (Math.abs(this._filtered) > this.engageDeg) {
        this.engaged = true;
        this._lastReported = Math.sign(this._filtered) * this.engageDeg;
      } else {
        res.engaged = false;
        res.deltaDeg = 0;
        return res;
      }
    }
    res.engaged = true;
    res.deltaDeg = this._filtered - this._lastReported;
    this._lastReported = this._filtered;
    return res;
  }
}
