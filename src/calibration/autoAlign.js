/**
 * Pure logic for gesture-driven yaw alignment (no three.js, no DOM).
 *
 * Key insight: WebXR gives gravity (pitch/roll) but not compass yaw. A push direction's
 * ELEVATION is therefore known in the real world, so it identifies WHICH bright object the
 * user is pushing toward (the one whose altitude matches); the yaw is then solved by
 * SkyCalibrator.snapToTarget(target.pos, pushDirWorld).
 */

export const DEFAULT_TOL_DEG = 5;
export const CYCLE_WINDOW_MS = 6000;

/**
 * Pick the reference object whose altitude best matches the push elevation.
 * Among candidates within tolDeg, the BRIGHTEST (lowest mag) wins; ties on mag -> closest altitude.
 * @param {Array<{name:string, alt:number, mag:number}>} candidates
 * @param {number} pushAltDeg
 * @param {{tolDeg?:number, exclude?:string[]}} [opts]
 * @returns {object|null}
 */
export function chooseReference(candidates, pushAltDeg, { tolDeg = DEFAULT_TOL_DEG, exclude = [] } = {}) {
  if (!Array.isArray(candidates) || !Number.isFinite(pushAltDeg)) return null;
  const skip = new Set(exclude);
  let best = null;
  for (const c of candidates) {
    if (!c || skip.has(c.name)) continue;
    const d = Math.abs(c.alt - pushAltDeg);
    if (d > tolDeg) continue;
    const mag = Number.isFinite(c.mag) ? c.mag : 99;
    if (!best || mag < best.mag || (mag === best.mag && d < best.d)) best = { c, mag, d };
  }
  return best ? best.c : null;
}

/**
 * Stateful wrapper adding "Not Vega? push again": a second push within 6 s at the same elevation
 * (within tolDeg) excludes what was chosen before and cycles to the next matching candidate.
 * When every match has been tried the cycle restarts from the brightest.
 */
export class PushResolver {
  constructor({ tolDeg = DEFAULT_TOL_DEG, windowMs = CYCLE_WINDOW_MS } = {}) {
    this.tolDeg = tolDeg;
    this.windowMs = windowMs;
    this.reset();
  }

  reset() {
    this.lastMs = -Infinity;
    this.lastAlt = 0;
    this.tried = [];
  }

  /** @returns {object|null} chosen target (null if nothing matches the elevation) */
  resolve(candidates, pushAltDeg, nowMs) {
    const repeat = nowMs - this.lastMs <= this.windowMs && Math.abs(pushAltDeg - this.lastAlt) <= this.tolDeg;
    if (!repeat) this.tried = [];
    let target = chooseReference(candidates, pushAltDeg, { tolDeg: this.tolDeg, exclude: this.tried });
    if (!target && this.tried.length) {
      this.tried = [];
      target = chooseReference(candidates, pushAltDeg, { tolDeg: this.tolDeg });
    }
    if (!target) {
      this.reset();
      return null;
    }
    this.tried.push(target.name);
    this.lastMs = nowMs;
    this.lastAlt = pushAltDeg;
    return target;
  }
}

/** Unit world direction for altitude/azimuth degrees (0 az = -Z "north", +az toward +X), matching snapToTarget. */
export function dirFromAltAz(altDeg, azDeg) {
  const a = (altDeg * Math.PI) / 180;
  const z = (azDeg * Math.PI) / 180;
  return { x: Math.cos(a) * Math.sin(z), y: Math.sin(a), z: -Math.cos(a) * Math.cos(z) };
}

/** Altitude (deg) of a world direction vector. */
export function altOfDir(d) {
  const len = Math.hypot(d.x, d.y, d.z) || 1;
  return (Math.asin(Math.max(-1, Math.min(1, d.y / len))) * 180) / Math.PI;
}
