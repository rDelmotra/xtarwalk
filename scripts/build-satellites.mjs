// Builds public/data/satellites.json: OMM records for naked-eye "visual" satellites + stations.
// Usage: node scripts/build-satellites.mjs
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data/satellites.json');
const LOCAL = '/Users/rehaandelmotra/Projects/orbitwatch/packages/backend/data';
const ALWAYS = [25544, 48274]; // ISS, CSS (Tianhe)
const FIELDS = ['OBJECT_NAME', 'OBJECT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'EPHEMERIS_TYPE', 'CLASSIFICATION_TYPE', 'NORAD_CAT_ID', 'ELEMENT_SET_NO',
  'REV_AT_EPOCH', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT'];

const slim = (o) => Object.fromEntries(FIELDS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

async function fetchJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function fromCelesTrak() {
  const base = 'https://celestrak.org/NORAD/elements/gp.php?FORMAT=json&GROUP=';
  const [vis, sta] = await Promise.all([fetchJson(base + 'visual'), fetchJson(base + 'stations')]);
  const map = new Map();
  for (const o of [...vis, ...sta.filter((s) => ALWAYS.includes(s.NORAD_CAT_ID))]) map.set(o.NORAD_CAT_ID, slim(o));
  return [...map.values()];
}

function fromLocal() {
  const ids = new Set([...JSON.parse(readFileSync(`${LOCAL}/visual-cache.json`, 'utf8')).ids, ...ALWAYS]);
  const all = JSON.parse(readFileSync(`${LOCAL}/tle-cache.json`, 'utf8'));
  const out = [];
  for (const r of all) if (ids.has(r.noradId) && r.omm) out.push(slim(r.omm));
  return out;
}

let source = 'CelesTrak (live)';
let list;
try { list = await fromCelesTrak(); } catch (e) {
  console.warn(`CelesTrak failed (${e.message || e.name}); using local orbitwatch cache`);
  source = 'orbitwatch local cache';
  list = fromLocal();
}
if (!list.length) throw new Error('no satellites produced');
list.sort((a, b) => a.NORAD_CAT_ID - b.NORAD_CAT_ID);
if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(list));
const ages = list.map((o) => (Date.now() - Date.parse(o.EPOCH.endsWith('Z') ? o.EPOCH : o.EPOCH + 'Z')) / 86400000).sort((a, b) => a - b);
console.log(`source: ${source}; ${list.length} objects; epoch age days: min ${ages[0].toFixed(1)}, median ${ages[ages.length >> 1].toFixed(1)}, max ${ages.at(-1).toFixed(1)}`);
console.log('has ISS:', list.some((o) => o.NORAD_CAT_ID === 25544), 'has CSS:', list.some((o) => o.NORAD_CAT_ID === 48274));
