// Pure time-dial model (no three.js, no DOM). See docs/time-dial-contract.md.
import * as Astronomy from 'astronomy-engine';

const MS_MIN = 60000;
const MS_HOUR = 3600000;
const MS_DAY = 86400000;
export const GAIN_DESKTOP = 12; // minutes of sky time per degree of dial (desktop drag)
export const GAIN_XR = 10;      // minutes per degree of wrist twist (~70 deg ~ 12 h)
// Momentum: smoothed angular velocity is sampled while scrubbing; on release a fast spin coasts.
const VEL_TAU_S = 0.05;         // velocity low-pass (~100 ms window)
const COAST_START_DPS = 25;     // min release speed (dial deg/s) to coast
const COAST_STOP_DPS = 3;       // below this the coast ends
const COAST_MAX_DPS = 720;
const COAST_TAU_S = 0.6;        // exponential friction time constant
const EDGE_TAU_S = 0.12;        // approach time constant into a window edge (soft stop)
const RESIST_DEG = 45;
const DETENT_MS = 9 * MS_MIN; // ±1.5°
const RELEASE_S = 0.3;

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export class TimeDial {
  constructor({ lat, lon, now = () => Date.now() }) {
    this._now = now;
    this._cbs = [];
    this._scrubbing = false;
    this._offsetMs = 0;
    this._r = 0;          // resistance 0..1
    this._edgeDir = 0;    // -1 start, +1 end, 0 none
    this._coasting = false;
    this._coastOk = true;
    this._vel = 0;        // smoothed dial deg/s
    this._acc = 0;        // input degrees since last tick
    this._gain = GAIN_DESKTOP;
    this._win = 0;        // absolute window index (window k = noon(k)..noon(k+1))
    this._winCache = new Map();
    this._setLoc(lat, lon);
    this._win = this._windowIndexAt(this._now());
  }

  _setLoc(lat, lon) {
    this.lat = lat;
    this.lon = lon;
    this._observer = new Astronomy.Observer(lat, lon, 0);
    this._noons = new Map();
    this._winCache.clear();
    this._anchor = null;
  }

  setLocation(lat, lon) {
    const shown = this._now() + this._offsetMs;
    this._setLoc(lat, lon);
    this._win = this._windowIndexAt(shown);
    this._emit();
  }

  // ---- solar noon chain ----
  _noon(k) {
    if (this._noons.has(k)) return this._noons.get(k);
    if (this._anchor === null) {
      // anchor index 0: latest solar noon at or before real now
      const now = this._now();
      let n = this._searchNoon(now - 1.1 * MS_DAY);
      while (true) {
        const next = this._searchNoon(n + 20 * MS_HOUR);
        if (next > now) break;
        n = next;
      }
      this._anchor = n;
      this._noons.set(0, n);
      if (k === 0) return n;
    }
    let v;
    if (k > 0) v = this._searchNoon(this._noon(k - 1) + 20 * MS_HOUR);
    else v = this._searchNoon(this._noon(k + 1) - 25 * MS_HOUR);
    this._noons.set(k, v);
    return v;
  }

  _searchNoon(fromMs) {
    try {
      const t = Astronomy.SearchHourAngle(Astronomy.Body.Sun, this._observer, 0, new Date(fromMs), +1);
      const ms = t.time.date.getTime();
      if (Number.isFinite(ms) && ms > fromMs) return ms;
    } catch (e) { /* fall through */ }
    // fallback: next local-time 12:00 after fromMs
    const d = new Date(fromMs);
    d.setHours(12, 0, 0, 0);
    if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  _windowIndexAt(ms) {
    let k = 0;
    while (this._noon(k) > ms) k--;
    while (this._noon(k + 1) <= ms) k++;
    return k;
  }

  _window(k) {
    let w = this._winCache.get(k);
    if (w) return w;
    const start = this._noon(k);
    const end = this._noon(k + 1);
    let sunset = null;
    let sunrise = null;
    try {
      const set = Astronomy.SearchRiseSet(Astronomy.Body.Sun, this._observer, -1, new Date(start), 1.2);
      if (set) {
        const sm = set.date.getTime();
        if (sm > start && sm < end) {
          sunset = new Date(sm);
          const rise = Astronomy.SearchRiseSet(Astronomy.Body.Sun, this._observer, +1, new Date(sm), 1.2);
          if (rise) {
            const rm = rise.date.getTime();
            if (rm > sm && rm < end) sunrise = new Date(rm);
          }
        }
      }
    } catch (e) { /* polar: no rise/set */ }
    w = { start, end, sunset, sunrise };
    this._winCache.set(k, w);
    return w;
  }

  // ---- gesture API ----
  /** @param {{coast?: boolean}} [opts] coast:false for wheel/keys (no momentum) */
  begin(opts = {}) {
    this._coasting = false; // grabbing stops a coast instantly
    this._coastOk = opts.coast !== false;
    this._vel = 0;
    this._acc = 0;
    this._scrubbing = true;
    this._syncWindow();
    this._offsetMs = this._shownOffset();
    this._emit();
  }

  _syncWindow() {
    this._win = this._windowIndexAt(this._now() + this._offsetMs);
  }

  /** @param {number} deltaDeg  @param {{gain?: number}} [opts] gain = minutes of sky time per dial degree */
  turn(deltaDeg, opts = {}) {
    if (!this._scrubbing || !deltaDeg) return;
    const gain = opts.gain > 0 ? opts.gain : GAIN_DESKTOP;
    this._gain = gain;
    this._acc += deltaDeg;
    const before = this._snapshotKey();
    let deg = deltaDeg;
    let guard = 0;
    while (deg !== 0 && guard++ < 8) {
      const w = this._window(this._win);
      const now = this._now();
      let shown = now + this._offsetMs;
      if (this._r > 0 && this._edgeDir !== 0) {
        // currently pressing against an edge
        if (Math.sign(deg) === this._edgeDir) {
          const room = (1 - this._r) * RESIST_DEG;
          if (Math.abs(deg) < room) { this._r += Math.abs(deg) / RESIST_DEG; deg = 0; break; }
          // click over
          deg -= this._edgeDir * room;
          this._r = 0;
          this._win += this._edgeDir;
          const nw = this._window(this._win);
          shown = this._edgeDir > 0 ? nw.start : nw.end;
          this._offsetMs = shown - now;
          this._edgeDir = 0;
          this.pendingDayClick = true;
          continue;
        }
        // backing off: spend the turn on relieving pressure first
        const need = this._r * RESIST_DEG;
        if (Math.abs(deg) < need - 1e-6) { this._r -= Math.abs(deg) / RESIST_DEG; deg = 0; break; }
        deg += this._edgeDir * need;
        this._r = 0;
        this._edgeDir = 0;
        continue;
      }
      const dMs = deg * gain * MS_MIN;
      const target = shown + dMs;
      if (target > w.end) {
        this._offsetMs = w.end - now;
        deg = (target - w.end) / (gain * MS_MIN);
        this._edgeDir = 1;
        this._r = 1e-9; // enter pressing state; loop applies resistance
        continue;
      }
      if (target < w.start) {
        this._offsetMs = w.start - now;
        deg = (target - w.start) / (gain * MS_MIN);
        this._edgeDir = -1;
        this._r = 1e-9;
        continue;
      }
      this._offsetMs = target - now;
      deg = 0;
    }
    if (before !== this._snapshotKey()) this._emit();
  }

  /** Offset the world sees: raw offset with the Now detent (±9 min) applied. */
  _shownOffset() {
    if (this._edgeDir === 0 && Math.abs(this._offsetMs) <= DETENT_MS &&
        this._win === this._windowIndexAt(this._now())) return 0;
    return this._offsetMs;
  }

  end() {
    if (!this._scrubbing) return;
    this._scrubbing = false;
    this._offsetMs = this._shownOffset();
    const v = Math.max(-COAST_MAX_DPS, Math.min(COAST_MAX_DPS, this._vel));
    if (this._coastOk && this._r === 0 && Math.abs(v) >= COAST_START_DPS) {
      this._coasting = true;
      this._vel = v;
    } else {
      this._vel = 0;
    }
    this._emit();
  }

  goLive() {
    this._coasting = false;
    this._vel = 0;
    this._scrubbing = false;
    this._offsetMs = 0;
    this._r = 0;
    this._edgeDir = 0;
    this._win = this._windowIndexAt(this._now());
    this._emit();
  }

  tick(dt) {
    if (this._scrubbing) {
      if (dt > 0) {
        const a = 1 - Math.exp(-dt / VEL_TAU_S);
        this._vel += (this._acc / dt - this._vel) * a;
      }
      this._acc = 0;
      return;
    }
    if (this._coasting) { this._coastStep(dt); return; }
    if (this._r <= 0) return;
    this._r = Math.max(0, this._r - dt / RELEASE_S);
    if (this._r <= 1e-6) { this._r = 0; this._edgeDir = 0; }
    this._emit();
  }

  _coastStep(dt) {
    if (!(dt > 0)) return;
    let v = this._vel * Math.exp(-dt / COAST_TAU_S);
    const w = this._window(this._win);
    const now = this._now();
    const shown = now + this._offsetMs;
    const k = this._gain * MS_MIN;
    // never cross a window edge: cap speed so we ease into it
    const dist = Math.max(0, (v > 0 ? w.end - shown : shown - w.start) / k);
    const vmax = dist / EDGE_TAU_S;
    if (Math.abs(v) > vmax) v = Math.sign(v) * vmax;
    if (Math.abs(v) < COAST_STOP_DPS) {
      this._coasting = false;
      this._vel = 0;
      this._offsetMs = this._shownOffset();
      this._emit();
      return;
    }
    const step = Math.min(Math.abs(v) * dt, dist) * Math.sign(v);
    this._vel = v;
    this._offsetMs += step * k;
    this._emit();
  }

  /** True once after a day click-over (haptics); resets on read. */
  consumeDayClick() {
    const v = !!this.pendingDayClick;
    this.pendingDayClick = false;
    return v;
  }

  onChange(cb) { this._cbs.push(cb); }

  _snapshotKey() {
    return `${this._shownOffset()}|${this._r}|${this._win}|${this._scrubbing}|${this._coasting}`;
  }

  _emit() {
    if (!this._cbs.length) return;
    const s = this.state;
    for (const cb of this._cbs) cb(s);
  }

  get state() {
    if (!this._scrubbing && !this._coasting && this._r === 0) this._syncWindow();
    const now = this._now();
    const w = this._window(this._win);
    const nowWin = this._windowIndexAt(now);
    const off = this._shownOffset();
    const shownMs = now + off;
    const date = new Date(shownMs);
    const isLive = off === 0 && this._win === nowWin;
    const dayShift = this._win - nowWin;
    const span = w.end - w.start;
    const dialAngleDeg = Math.max(0, Math.min(360, ((shownMs - w.start) / span) * 360));
    return {
      offsetHours: off / MS_HOUR,
      date,
      isLive,
      scrubbing: this._scrubbing || this._coasting,
      coasting: this._coasting,
      windowStart: new Date(w.start),
      windowEnd: new Date(w.end),
      sunset: w.sunset,
      sunrise: w.sunrise,
      dayShift,
      edge: this._r > 0 ? (this._edgeDir > 0 ? 'end' : 'start') : 'none',
      resistance: Math.min(1, this._r < 1e-6 ? 0 : this._r),
      dialAngleDeg,
      label: makeLabel(dayShift, date, isLive, w.sunset, w.sunrise),
      relLabel: makeRel(off, isLive)
    };
  }
}

function dayName(shift) {
  if (shift === 0) return 'Tonight';
  if (shift === 1) return 'Tomorrow night';
  if (shift === -1) return 'Last night';
  if (shift > 1) return `In ${shift} nights`;
  return `${-shift} nights ago`;
}

function dayWord(k, part) {
  if (k === 0) return `This ${part}`;
  if (k === 1) return `Tomorrow ${part}`;
  if (k === -1) return `Yesterday ${part}`;
  return k > 1 ? `In ${k} days, ${part}` : `${-k} days ago, ${part}`;
}

// The window runs noon→noon: before sunset it's that day's afternoon, after sunrise the next day's morning.
function makeLabel(shift, date, live, sunset, sunrise) {
  if (live) return `Live · ${hhmm(date)}`;
  const t = date.getTime();
  let when = dayName(shift);
  if (sunset && t < sunset.getTime()) when = dayWord(shift, 'afternoon');
  else if (sunrise && t >= sunrise.getTime()) when = dayWord(shift + 1, 'morning');
  return `${when} · ${hhmm(date)}`;
}

function makeRel(offsetMs, live) {
  if (live) return 'Live';
  const sign = offsetMs < 0 ? '−' : '+';
  const totalMin = Math.round(Math.abs(offsetMs) / MS_MIN);
  const days = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (days > 0) {
    const parts = [`${days} day${days > 1 ? 's' : ''}`];
    if (h) parts.push(`${h}h`);
    return `${sign}${parts.join(' ')}`;
  }
  return h ? `${sign}${h}h ${m}m` : `${sign}${m}m`;
}
