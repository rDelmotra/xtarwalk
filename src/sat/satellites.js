import * as THREE from 'three';
import { json2satrec } from '@sat-core/io.js';
import { propagate, gstime } from '@sat-core/propagation.js';
import { eciToEcf, ecfToLookAngles } from '@sat-core/transforms.js';
const sat = { json2satrec, propagate, gstime, eciToEcf, ecfToLookAngles };
import { altAzToVec3, SKY_RADIUS } from '../astro/skyEngine.js';
import { sunEciUnit, inEarthShadow, sunAltitudeDeg } from './satMath.js';

const DEG = Math.PI / 180;
const DRAW_R = SKY_RADIUS * 0.97;
const SHADOW_BRIGHT = 0.08;

const VERT = /* glsl */ `
  attribute float aBright;
  attribute float aSize;
  uniform float uPixelScale;
  varying float vBright;
  varying float vSigma;
  varying float vSize;
  void main() {
    vBright = aBright;
    vSigma = (0.9 + 0.5 * aSize) * uPixelScale;
    vSize = (vSigma * 7.0 + 6.0) * step(0.001, aBright);
    gl_PointSize = vSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uNightMode;
  varying float vBright;
  varying float vSigma;
  varying float vSize;
  void main() {
    vec2 d = (gl_PointCoord - vec2(0.5)) * vSize;
    float r = length(d);
    float core = exp(-0.5 * r * r / (vSigma * vSigma)) + 0.5 * exp(-r * r * 1.8);
    float halo = 0.22 * exp(-r / (vSigma * 1.6));
    float edge = 1.0 - smoothstep(0.7 * 0.5 * vSize, 0.5 * vSize, r);
    vec3 col = uColor * (core + halo) * vBright * edge;
    float l = dot(col, vec3(0.3, 0.59, 0.11));
    col = mix(col, vec3(1.0, 0.22, 0.18) * l * 1.2, uNightMode);
    gl_FragColor = vec4(col, 1.0);
  }
`;

/** Naked-eye satellites + stations drawn on the sky dome, from OMM elements via SGP4. */
/**
 * The bundled snapshot ages (positions drift a few km per day). On a network where CelesTrak answers,
 * swap in today's elements for the same objects; otherwise keep the snapshot. Never blocks for long.
 */
async function refreshFromCelesTrak(snapshot) {
  const groups = ['visual', 'stations'];
  const fresh = new Map();
  await Promise.all(groups.map(async (g) => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=json`, { signal: ctl.signal });
      clearTimeout(timer);
      if (!r.ok) return;
      for (const o of await r.json()) fresh.set(+o.NORAD_CAT_ID, o);
    } catch { /* offline / blocked / CORS: keep the snapshot */ }
  }));
  if (!fresh.size) return snapshot;
  const out = snapshot.map((o) => fresh.get(+o.NORAD_CAT_ID) ?? o);
  console.info(`[satellites] refreshed ${out.filter((o) => fresh.has(+o.NORAD_CAT_ID)).length}/${out.length} from CelesTrak`);
  return out;
}

export class Satellites {
  constructor(parentGroup) {
    this.parent = parentGroup;
    this.items = []; // { name, noradId, satrec, big }
    this.lat = 0; this.lon = 0; this.alt = 0;
    this.visible = true;
    this.dayVis = 1;
    this.sunAlt = -30;
    this.selected = null;
    this._skyQ = new THREE.Quaternion();
    this._d = new THREE.Vector3();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPixelScale: { value: 1 },
        uColor: { value: new THREE.Color(1.0, 0.96, 0.86) },
        uNightMode: { value: 0 }
      },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending
    });
    this.points = null;
    this._v2 = new THREE.Vector2();
  }

  async load(url = `${import.meta.env.BASE_URL}data/satellites.json`) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`satellites.json HTTP ${res.status}`);
    let omms = await res.json();
    omms = await refreshFromCelesTrak(omms);
    for (const omm of omms) {
      try {
        const satrec = sat.json2satrec(omm);
        if (satrec.error) continue;
        this.items.push({ name: omm.OBJECT_NAME, noradId: omm.NORAD_CAT_ID, satrec, big: omm.NORAD_CAT_ID === 25544 || omm.NORAD_CAT_ID === 48274 });
      } catch { /* skip bad record */ }
    }
    const n = this.items.length;
    if (!n) throw new Error('no usable satellites');
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.bright = new Float32Array(n);
    this.sizes = Float32Array.from(this.items, (it) => (it.big ? 1.6 : 0.6));
    this.state = this.items.map(() => ({ alt: -90, az: 0, range: 0, sunlit: false }));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aBright', new THREE.BufferAttribute(this.bright, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.points.visible = this.visible;
    this.points.onBeforeRender = (renderer, _s, camera) => {
      let h = 0;
      if (camera && camera.isArrayCamera && camera.cameras.length) h = camera.cameras[0].viewport.w;
      else h = renderer.getDrawingBufferSize(this._v2).y;
      if (h > 0) this.material.uniforms.uPixelScale.value = Math.max(1, h / 1000);
    };
    this.parent.add(this.points);
    return n;
  }

  setObserver(lat, lon, altKm = 0) { this.lat = lat; this.lon = lon; this.alt = altKm; }
  setVisible(v) { this.visible = v; if (this.points) this.points.visible = v; }
  setDayVisibility(v) { this.dayVis = v; }
  setNightMode(on) { this.material.uniforms.uNightMode.value = on ? 1 : 0; }

  /** Propagate everything to `date`; updates GPU attributes and per-satellite alt/az. */
  update(date) {
    if (!this.points) return;
    const gmst = sat.gstime(date);
    const sun = sunEciUnit(date);
    this.sunAlt = sunAltitudeDeg(sun, gmst, this.lat, this.lon);
    const obs = { latitude: this.lat * DEG, longitude: this.lon * DEG, height: this.alt };
    for (let i = 0; i < this.n; i++) {
      const st = this.state[i];
      let b = 0;
      try {
        const pv = sat.propagate(this.items[i].satrec, date);
        if (pv && pv.position && typeof pv.position === 'object') {
          const ecf = sat.eciToEcf(pv.position, gmst);
          const la = sat.ecfToLookAngles(obs, ecf);
          st.alt = la.elevation / DEG;
          st.az = ((la.azimuth / DEG) % 360 + 360) % 360;
          st.range = la.rangeSat;
          st.sunlit = !inEarthShadow(pv.position, sun);
          if (st.alt > 0) {
            b = (st.sunlit ? 1 : SHADOW_BRIGHT) * (this.items[i].big ? 1.5 : 1) * this.dayVis;
            const v = altAzToVec3(st.alt, st.az, DRAW_R);
            this.pos[i * 3] = v.x; this.pos[i * 3 + 1] = v.y; this.pos[i * 3 + 2] = v.z;
          }
        } else st.alt = -90;
      } catch { st.alt = -90; }
      this.bright[i] = b;
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aBright.needsUpdate = true;
    if (this.selected) this._refreshTarget(this.selected);
  }

  _targetFor(i) {
    const it = this.items[i];
    const t = { kind: 'satellite', index: i, noradId: it.noradId, name: it.name, pos: { x: 0, y: 0, z: 0 } };
    this._refreshTarget(t);
    return t;
  }

  _refreshTarget(t) {
    const st = this.state[t.index];
    const v = altAzToVec3(st.alt, st.az, DRAW_R);
    t.pos.x = v.x; t.pos.y = v.y; t.pos.z = v.z;
    t.alt = st.alt; t.az = st.az; t.rangeKm = st.range; t.sunlit = st.sunlit;
    t.subtitle = `Satellite • NORAD ${t.noradId}`;
    t.extra = `Range ${Math.round(st.range).toLocaleString()} km<br/>${st.sunlit ? 'In sunlight' : "In Earth's shadow"}`
      + (st.alt <= 0 ? '<br/>Below the horizon' : '');
  }

  /** Select (or clear with null) a satellite target; its position/alt/az keep following the updates. */
  setSelected(t) { this.selected = t && t.kind === 'satellite' ? t : null; }

  /** Nearest visible satellite to a world-space direction, or null. */
  pick(dirWorld, fovDeg = 65) {
    if (!this.points || !this.visible) return null;
    this.parent.getWorldQuaternion(this._skyQ).invert();
    const d = this._d.copy(dirWorld).normalize().applyQuaternion(this._skyQ);
    const maxDeg = Math.max(1.5, fovDeg * 0.04);
    const cosMax = Math.cos(maxDeg * DEG);
    let best = -1, bestC = cosMax;
    for (let i = 0; i < this.n; i++) {
      if (this.bright[i] <= 0.001) continue;
      const c = (this.pos[i * 3] * d.x + this.pos[i * 3 + 1] * d.y + this.pos[i * 3 + 2] * d.z) / DRAW_R;
      if (c > bestC) { bestC = c; best = i; }
    }
    return best < 0 ? null : this._targetFor(best);
  }

  dispose() {
    if (this.points) { this.parent.remove(this.points); this.points.geometry.dispose(); }
    this.material.dispose();
    this.points = null;
  }
}
