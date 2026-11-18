// Pure helpers for the satellite overlay (no three.js, easily unit-tested).
const DEG = Math.PI / 180;
export const EARTH_RADIUS_KM = 6378.137;

/** Low-precision (~0.01 deg) unit vector toward the Sun in the equatorial (ECI/TEME-like) frame. */
export function sunEciUnit(date) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0; // days since J2000
  const L = (280.460 + 0.9856474 * n) * DEG;
  const g = (357.528 + 0.9856003 * n) * DEG;
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  return { x: Math.cos(lam), y: Math.cos(eps) * Math.sin(lam), z: Math.sin(eps) * Math.sin(lam) };
}

/** Cylindrical-umbra test: is an ECI position (km) inside Earth's shadow? sun = unit vector toward Sun. */
export function inEarthShadow(pos, sun) {
  const dot = pos.x * sun.x + pos.y * sun.y + pos.z * sun.z;
  if (dot >= 0) return false; // on the sunward side
  const r2 = pos.x * pos.x + pos.y * pos.y + pos.z * pos.z;
  return r2 - dot * dot < EARTH_RADIUS_KM * EARTH_RADIUS_KM;
}

/** Sun altitude (deg) for an observer, from the Sun's ECI unit vector and Greenwich sidereal time (rad). */
export function sunAltitudeDeg(sun, gmstRad, latDeg, lonDeg) {
  const lst = gmstRad + lonDeg * DEG;
  const lat = latDeg * DEG;
  const s = Math.cos(lat) * Math.cos(lst) * sun.x + Math.cos(lat) * Math.sin(lst) * sun.y + Math.sin(lat) * sun.z;
  return Math.asin(Math.max(-1, Math.min(1, s))) / DEG;
}
