/**
 * One-tap yaw calibration for gravity-aligned XR spaces.
 * Rotates SkyRoot around +Y so a known celestial target aligns with the user's pointing ray.
 */
const STORAGE_KEY = 'xtarwalk.calibration.yaw.v1';

export class SkyCalibrator {
  constructor() {
    this.targetYaw = 0;
    this.currentYaw = 0;
    this.calibrating = false;
  }

  /**
   * Persist the yaw offset. DESKTOP ONLY: an XR session's reference space has an arbitrary
   * yaw that differs between sessions (headset recentre / new boot), so a stored offset is
   * meaningless there. main.js calls loadSaved() on desktop and reset(true) on each XR start.
   */
  save() {
    try { localStorage.setItem(STORAGE_KEY, String(this.targetYaw)); } catch (e) { /* storage unavailable */ }
  }

  loadSaved() {
    try {
      const v = parseFloat(localStorage.getItem(STORAGE_KEY));
      if (Number.isFinite(v)) {
        this.targetYaw = v;
        this.currentYaw = v;
      }
    } catch (e) { /* storage unavailable */ }
  }

  startCalibration() {
    this.calibrating = true;
  }

  cancelCalibration() {
    this.calibrating = false;
  }

  /**
   * @param {{x: number, y: number, z: number}} skyLocalPos - Target position in SkyRoot local space
   * @param {{x: number, y: number, z: number}} worldDir - User pointing direction in world space
   */
  snapToTarget(skyLocalPos, worldDir) {
    const targetAz = Math.atan2(skyLocalPos.x, -skyLocalPos.z);
    const pointerAz = Math.atan2(worldDir.x, -worldDir.z);
    let delta = targetAz - pointerAz;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.targetYaw = delta;
    this.calibrating = false;
    return this.getOffsetDegrees();
  }

  /** @param {boolean} immediate - skip the ease and jump to zero yaw */
  reset(immediate = false) {
    this.targetYaw = 0;
    if (immediate) this.currentYaw = 0;
    this.calibrating = false;
  }

  update(dt) {
    let diff = this.targetYaw - this.currentYaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const t = Math.min(1, dt * 8);
    this.currentYaw += diff * t;
    return this.currentYaw;
  }

  getOffsetDegrees() {
    let deg = (this.targetYaw * 180) / Math.PI;
    while (deg > 180) deg -= 360;
    while (deg < -180) deg += 360;
    return deg;
  }
}
