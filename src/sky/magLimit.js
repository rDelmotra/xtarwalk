/**
 * Limiting magnitude = "how faint a star you can see right now". Pure, no three.js / DOM.
 *
 * AUTO estimate (what the naked eye sees tonight):
 *   base sky (default 5.5, a suburban sky; a truly dark site is ~6.5, a big city ~3.5)
 *   − twilight: the sky brightens fast as the Sun climbs from −18° to 0° (down to ~−1 in daylight)
 *   − moonlight: a bright Moon above the horizon washes out faint stars (full Moon ≈ −1.2 mag)
 * The user's LEFT-hand twist adds an offset on top of that (more stars / fewer stars).
 */
export const MAG_MIN = 1.0;   // never hide the brightest stars
export const MAG_MAX = 6.5;   // our catalogue goes to ~6
export const MAG_PER_DEG = 0.025; // 40 deg of twist = 1 magnitude

export function autoLimit({ sunAltDeg = -30, moonAltDeg = -10, moonPhase = 0, base = 5.5 } = {}) {
  // twilight: astronomical (−18°) → no effect, civil (−6°) → ~−2.5, sunrise → daylight
  const tw = clamp01((sunAltDeg + 18) / 18);           // 0 at −18°, 1 at 0°
  let lim = base - (base + 1) * Math.pow(tw, 1.6);     // ends near −1 at sunrise
  // moonlight scales with phase and with how high the Moon is
  if (moonAltDeg > 0) {
    const height = clamp01(moonAltDeg / 25);
    lim -= 1.2 * Math.pow(clamp01(moonPhase), 1.5) * (0.4 + 0.6 * height);
  }
  return clamp(lim, MAG_MIN, MAG_MAX);
}

export class MagControl {
  constructor() {
    this.offset = 0;
    this.auto = 5.5;
  }

  setAuto(v) { this.auto = v; }

  /** + = clockwise = show fainter stars. */
  turn(deltaDeg) {
    this.offset = clamp(this.offset + deltaDeg * MAG_PER_DEG, MAG_MIN - this.auto, MAG_MAX - this.auto);
  }

  resetToAuto() { this.offset = 0; }

  get isAuto() { return Math.abs(this.offset) < 0.05; }

  get limit() { return clamp(this.auto + this.offset, MAG_MIN, MAG_MAX); }

  /** Display text, e.g. { main: 'Mag 5.2', sub: 'Auto' } or sub '+0.8 more stars'. */
  get labels() {
    const sub = this.isAuto ? 'Auto' : `${this.offset > 0 ? '+' : '−'}${Math.abs(this.offset).toFixed(1)} ${this.offset > 0 ? 'fainter' : 'brighter only'}`;
    return { main: `Mag ${this.limit.toFixed(1)}`, sub };
  }
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
