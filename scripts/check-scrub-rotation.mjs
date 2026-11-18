// Verifies SkyScene.setScrubPreview's rotation law against exact astronomy-engine positions.
// Mirrors skyScene.js: q = axisAngle(pole, -dtHours * 15.04107 deg), pole = altAzToVec3(lat, 0) normalised.
// Run: node scripts/check-scrub-rotation.mjs
import fs from 'node:fs';
import * as Astronomy from 'astronomy-engine';
import { altAzToVec3 } from '../src/astro/skyEngine.js';

const LAT = 28.61, LON = 77.21;
const DEG = Math.PI / 180;
const stars = JSON.parse(fs.readFileSync(new URL('../public/data/stars.6.json', import.meta.url))).features;
const names = JSON.parse(fs.readFileSync(new URL('../public/data/starnames.json', import.meta.url)));
const WANT = ['Vega', 'Sirius', 'Polaris', 'Arcturus', 'Capella', 'Betelgeuse', 'Altair', 'Rigel'];
const picks = stars.filter((f) => WANT.includes(names[String(f.id)]?.name));

const observer = new Astronomy.Observer(LAT, LON, 200);
const refDate = new Date('2000-01-01T12:00:00Z');
const eqj = (f) => {
  const [lon, lat] = f.geometry.coordinates;
  return Astronomy.VectorFromSphere(new Astronomy.Spherical(lat, ((lon % 360) + 360) % 360, 1), refDate);
};
// same pipeline as computeSkySnapshot.toPos
const pos = (v, date) => {
  const rot = Astronomy.Rotation_EQJ_HOR(date, observer);
  const sph = Astronomy.HorizonFromVector(Astronomy.RotateVector(rot, v), 'normal');
  const p = altAzToVec3(sph.lat, sph.lon, 1);
  return { x: p.x, y: p.y, z: p.z, alt: sph.lat };
};
// Rodrigues rotation of v about unit axis k by angle a (right-handed)
const rotate = (v, k, a) => {
  const c = Math.cos(a), s = Math.sin(a), d = k.x * v.x + k.y * v.y + k.z * v.z;
  const cr = { x: k.y * v.z - k.z * v.y, y: k.z * v.x - k.x * v.z, z: k.x * v.y - k.y * v.x };
  return { x: v.x * c + cr.x * s + k.x * d * (1 - c), y: v.y * c + cr.y * s + k.y * d * (1 - c), z: v.z * c + cr.z * s + k.z * d * (1 - c) };
};
const pole = (() => { const p = altAzToVec3(LAT, 0, 1); const n = Math.hypot(p.x, p.y, p.z); return { x: p.x / n, y: p.y / n, z: p.z / n }; })();

const t0 = new Date('2026-11-18T14:00:00Z');
let worst = 0;
for (const dh of [3, -5, 8, 0.25]) {
  const t1 = new Date(t0.getTime() + dh * 3.6e6);
  for (const f of picks) {
    const v = eqj(f);
    const p0 = pos(v, t0), p1 = pos(v, t1);
    const pr = rotate(p0, pole, -dh * 15.04107 * DEG);
    const err = Math.acos(Math.min(1, pr.x * p1.x + pr.y * p1.y + pr.z * p1.z)) / DEG;
    const up = p0.alt > 10 && p1.alt > 10; // below ~10 deg, 'normal' refraction (up to ~0.5 deg) dominates
    if (up) worst = Math.max(worst, err);
    console.log(`dt=${String(dh).padStart(5)}h ${names[String(f.id)].name.padEnd(10)} alt0=${p0.alt.toFixed(1).padStart(6)} alt1=${p1.alt.toFixed(1).padStart(6)} err=${err.toFixed(4)} deg${up ? '' : '  (below horizon; ignored)'}`);
  }
}
// Sign sanity: a star on the east horizon must go UP for +dt.
const east = rotate({ x: 1, y: 0, z: 0 }, pole, -1 * 15.04107 * DEG);
console.log(`east-horizon star after +1h: y=${east.y.toFixed(4)} (expect > 0)`);
console.log(`max error, stars above 10 deg at both times: ${worst.toFixed(4)} deg`);
process.exit(worst < 0.2 && east.y > 0 ? 0 : 1);
