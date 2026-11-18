import * as Astronomy from 'astronomy-engine';

const DEG2RAD = Math.PI / 180;

export const SKY_RADIUS = 80;

export const PLANET_DEFS = [
  { body: Astronomy.Body.Sun, name: 'Sun', color: 0xfff3b0, size: 1.45, type: 'Star (Solar)' },
  { body: Astronomy.Body.Moon, name: 'Moon', color: 0xe2e8f0, size: 1.35, type: 'Natural Satellite' },
  { body: Astronomy.Body.Mercury, name: 'Mercury', color: 0xcbd5e1, size: 0.42, type: 'Planet' },
  { body: Astronomy.Body.Venus, name: 'Venus', color: 0xfef08a, size: 0.68, type: 'Planet' },
  { body: Astronomy.Body.Mars, name: 'Mars', color: 0xf87171, size: 0.56, type: 'Planet' },
  { body: Astronomy.Body.Jupiter, name: 'Jupiter', color: 0xfdba74, size: 0.72, type: 'Planet' },
  { body: Astronomy.Body.Saturn, name: 'Saturn', color: 0xfde68a, size: 0.62, type: 'Planet' },
  { body: Astronomy.Body.Uranus, name: 'Uranus', color: 0x67e8f9, size: 0.44, type: 'Planet' },
  { body: Astronomy.Body.Neptune, name: 'Neptune', color: 0x60a5fa, size: 0.42, type: 'Planet' }
];

/**
 * Convert Horizontal (altitude, azimuth in degrees) to Three.js Y-up coordinates.
 * +X = East, +Y = Up (Zenith), -Z = North.
 */
export function altAzToVec3(altDeg, azDeg, radius = SKY_RADIUS) {
  const alt = altDeg * DEG2RAD;
  const az = azDeg * DEG2RAD;
  const cosAlt = Math.cos(alt);
  return {
    x: radius * cosAlt * Math.sin(az),
    y: radius * Math.sin(alt),
    z: -radius * cosAlt * Math.cos(az)
  };
}

/**
 * Approximate RGB [0..1] from Johnson B-V color index.
 */
export function bvToRgb(bvRaw) {
  const bv = Number.isFinite(bvRaw) ? Math.max(-0.4, Math.min(2.0, bvRaw)) : 0.65;
  let r, g, b;
  if (bv < 0.0) {
    const t = (bv + 0.4) / 0.4;
    r = 0.61 + 0.22 * t;
    g = 0.70 + 0.20 * t;
    b = 1.0;
  } else if (bv < 0.4) {
    const t = bv / 0.4;
    r = 0.83 + 0.17 * t;
    g = 0.90 + 0.10 * t;
    b = 1.0;
  } else if (bv < 1.0) {
    const t = (bv - 0.4) / 0.6;
    r = 1.0;
    g = 1.0 - 0.16 * t;
    b = 1.0 - 0.38 * t;
  } else {
    const t = (bv - 1.0) / 1.0;
    r = 1.0;
    g = 0.84 - 0.34 * t;
    b = 0.62 - 0.40 * t;
  }
  return [r, g, b];
}

export async function loadSkyCatalog() {
  const [starsRes, linesRes, constRes, namesRes] = await Promise.all([
    fetch('/data/stars.6.json').then((r) => r.json()),
    fetch('/data/constellations.lines.json').then((r) => r.json()),
    fetch('/data/constellations.json').then((r) => r.json()),
    fetch('/data/starnames.json').then((r) => r.json())
  ]);

  const refDate = new Date('2000-01-01T12:00:00Z');
  const eqjVec = (lonDeg, latDeg) => {
    const raDeg = ((lonDeg % 360) + 360) % 360;
    return Astronomy.VectorFromSphere(new Astronomy.Spherical(latDeg, raDeg, 1.0), refDate);
  };

  const stars = starsRes.features.map((f) => {
    const [lon, lat] = f.geometry.coordinates;
    const mag = Number(f.properties.mag ?? 6.0);
    const bv = parseFloat(f.properties.bv);
    const meta = namesRes[String(f.id)];
    return {
      id: f.id,
      name: meta?.name || null,
      bayer: meta?.bayer || '',
      flam: meta?.flam || '',
      hip: meta?.hip || `HIP ${f.id}`,
      hd: meta?.hd || '',
      constellation: meta?.c || '',
      bv: Number.isFinite(bv) ? bv : null,
      mag,
      rgb: bvToRgb(bv),
      eqj: eqjVec(lon, lat)
    };
  });

  const constNameById = new Map();
  const constellations = constRes.features.map((f) => {
    const [lon, lat] = f.geometry.coordinates;
    const name = f.properties.en || f.properties.name || f.id;
    constNameById.set(f.id, name);
    return {
      id: f.id,
      name,
      eqj: eqjVec(lon, lat)
    };
  });

  for (const st of stars) st.conName = constNameById.get(st.constellation) || '';

  const lineSegments = [];
  for (const f of linesRes.features) {
    const cname = constNameById.get(f.id) || f.id;
    for (const poly of f.geometry.coordinates) {
      for (let i = 0; i < poly.length - 1; i++) {
        lineSegments.push({
          constellation: cname,
          a: eqjVec(poly[i][0], poly[i][1]),
          b: eqjVec(poly[i + 1][0], poly[i + 1][1])
        });
      }
    }
  }

  return { stars, constellations, lineSegments };
}

export function computeSkySnapshot(catalog, date, lat, lon, elev = 200) {
  const observer = new Astronomy.Observer(lat, lon, elev);
  const rot = Astronomy.Rotation_EQJ_HOR(date, observer);

  const toPos = (eqj) => {
    const hor = Astronomy.RotateVector(rot, eqj);
    const sph = Astronomy.HorizonFromVector(hor, 'normal');
    return {
      alt: sph.lat,
      az: sph.lon,
      pos: altAzToVec3(sph.lat, sph.lon, SKY_RADIUS)
    };
  };

  const starPositions = new Float32Array(catalog.stars.length * 3);
  const allNamedStars = [];
  for (let i = 0; i < catalog.stars.length; i++) {
    const s = catalog.stars[i];
    const { alt, az, pos } = toPos(s.eqj);
    starPositions[i * 3] = pos.x;
    starPositions[i * 3 + 1] = pos.y;
    starPositions[i * 3 + 2] = pos.z;

    if (s.name && s.mag <= 2.6) {
      allNamedStars.push({
        kind: 'star',
        name: s.name,
        subtitle: s.constellation ? `${s.bayer || ''} ${s.constellation}`.trim() : 'Bright Star',
        mag: s.mag,
        alt,
        az,
        pos
      });
    }
  }

  const linePositions = new Float32Array(catalog.lineSegments.length * 6);
  for (let i = 0; i < catalog.lineSegments.length; i++) {
    const seg = catalog.lineSegments[i];
    const pA = toPos(seg.a).pos;
    const pB = toPos(seg.b).pos;
    const base = i * 6;
    linePositions[base] = pA.x;
    linePositions[base + 1] = pA.y;
    linePositions[base + 2] = pA.z;
    linePositions[base + 3] = pB.x;
    linePositions[base + 4] = pB.y;
    linePositions[base + 5] = pB.z;
  }

  const allConstellationLabels = [];
  for (const c of catalog.constellations) {
    const { alt, az, pos } = toPos(c.eqj);
    {
      allConstellationLabels.push({
        kind: 'constellation',
        name: c.name,
        subtitle: 'Constellation',
        alt,
        az,
        pos
      });
    }
  }

  // Subsets keep object identity with the "all" lists (same target objects).
  const visibleNamedStars = allNamedStars.filter((st) => st.alt > -2);
  const constellationLabels = allConstellationLabels.filter((c) => c.alt > 5);

  return {
    starPositions,
    linePositions,
    visibleNamedStars,
    constellationLabels,
    // Full lists (no horizon cull) so the scene can show stars that rotate above the horizon
    // during a time-scrub preview.
    allNamedStars,
    allConstellationLabels,
    solarSystem: computeSolarSystem(date, lat, lon, elev),
    lat,
    lon,
    date: new Date(date.getTime())
  };
}

/** Exact Sun/Moon/planet positions for `date` (alt/az + scene pos). Cheap enough for ~15 Hz. */
export function computeSolarSystem(date, lat, lon, elev = 200) {
  const observer = new Astronomy.Observer(lat, lon, elev);
  const solarSystem = [];
  for (const def of PLANET_DEFS) {
    const eq = Astronomy.Equator(def.body, date, observer, true, true);
    const hor = Astronomy.Horizon(date, observer, eq.ra, eq.dec, 'normal');
    const illum = Astronomy.Illumination(def.body, date);
    let extra = `Mag ${illum.mag.toFixed(1)}`;
    if (def.body === Astronomy.Body.Moon) {
      const phaseDeg = Astronomy.MoonPhase(date);
      extra = `${Math.round(illum.phase_fraction * 100)}% lit (${describeMoonPhase(phaseDeg)})`;
    }
    solarSystem.push({
      kind: 'planet',
      name: def.name,
      subtitle: def.type,
      color: def.color,
      size: def.size,
      mag: illum.mag,
      distAu: eq.dist,
      extra,
      alt: hor.altitude,
      az: hor.azimuth,
      pos: altAzToVec3(hor.altitude, hor.azimuth, SKY_RADIUS * 0.96)
    });
  }
  return solarSystem;
}

function describeMoonPhase(deg) {
  if (deg < 22.5 || deg >= 337.5) return 'New';
  if (deg < 67.5) return 'Waxing Crescent';
  if (deg < 112.5) return 'First Quarter';
  if (deg < 157.5) return 'Waxing Gibbous';
  if (deg < 202.5) return 'Full';
  if (deg < 247.5) return 'Waning Gibbous';
  if (deg < 292.5) return 'Last Quarter';
  return 'Waning Crescent';
}

/** Human-readable colour/type hint from the B−V colour index (what the eye sees). */
export function describeStarColour(bv) {
  if (bv === null || bv === undefined) return '';
  if (bv < -0.1) return 'Blue-white star';
  if (bv < 0.3) return 'White star';
  if (bv < 0.6) return 'Yellow-white star';
  if (bv < 0.9) return 'Yellow star';
  if (bv < 1.3) return 'Orange star';
  return 'Red-orange star';
}

/** Best display name: proper name, else Bayer/Flamsteed + constellation, else the HIP number. */
export function starDisplayName(st) {
  if (st.name) return st.name;
  if (st.bayer && st.constellation) return `${st.bayer} ${st.constellation}`;
  if (st.flam && st.constellation) return `${st.flam} ${st.constellation}`;
  return st.hip;
}
