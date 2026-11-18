// Desktop/phone time dial ("Eye of Agamotto") rendered as SVG inside #time-dial.
// Contract: docs/time-dial-contract.md. Angles: 0° = top (window start, solar noon), clockwise.
const NS = 'http://www.w3.org/2000/svg';
const C = 110; // centre of the 220x220 viewBox
const R_TRACK = 80;
const WHEEL_PER_PX = 0.08; // dial deg per wheel pixel (smooth on trackpads)
const WHEEL_MAX_DEG = 14;
const IDLE_MS = 2500;      // after this much quiet the dial fades back into the sky
const KEY_DEG = 3;

const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
};
const pt = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
};
const arcPath = (r, a0, a1) => {
  if (a1 - a0 >= 359.9) a1 = a0 + 359.9;
  const [x0, y0] = pt(r, a0);
  const [x1, y1] = pt(r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

export class DesktopDial {
  constructor(containerEl, { onBegin, onTurn, onEnd, onLive } = {}) {
    this.root = containerEl;
    this.cb = { onBegin, onTurn, onEnd, onLive };
    this.lastKey = '';
    this.spin = 0;
    this.spinSpeed = 6; // deg/s, eased
    this.scrubbing = false;
    this.pointerId = null;
    this.lastAngle = 0;
    this.wheelActive = false;
    this.wheelTimer = 0;
    this.keyActive = false;
    this.keyTimer = 0;
    this.lastT = performance.now();
    this.disposed = false;
    this.hovering = false;
    this.idleTimer = 0;

    this.root.classList.add('dial-root');
    this.root.innerHTML = '';
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'dial-hint';
    this.root.appendChild(this.hintEl);

    const svg = el('svg', { viewBox: '0 0 220 220', class: 'dial-svg', tabindex: '0', role: 'slider',
      'aria-label': 'Time dial: drag around, scroll, or use arrow keys' });
    this.svg = svg;
    this.root.appendChild(svg);

    // Minimal: one hairline circle, the night band, a thin progress arc, 4 marks, a needle dot.
    this.rune = el('g', {}, svg); // (kept for tickSpin; intentionally empty)
    el('circle', { cx: C, cy: C, r: R_TRACK, class: 'd-ring-thin' }, svg);
    this.night = el('path', { class: 'd-night', d: '' }, svg);
    this.progress = el('path', { class: 'd-progress', d: '' }, svg);
    for (let i = 0; i < 4; i++) {
      const [x0, y0] = pt(R_TRACK + 4, i * 90);
      const [x1, y1] = pt(R_TRACK - 4, i * 90);
      el('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: 'd-tick major' }, svg);
    }
    this.setG = el('g', { visibility: 'hidden' }, svg);
    this.riseG = el('g', { visibility: 'hidden' }, svg);
    this.edgeRing = el('circle', { cx: C, cy: C, r: R_TRACK, class: 'd-edge' }, svg);
    this.needle = el('g', { class: 'd-needle' }, svg);
    el('circle', { cx: C, cy: C - R_TRACK, r: 3.2, class: 'd-needle-dot' }, this.needle);

    // Centre text.
    this.t1 = el('text', { x: C, y: C - 14, class: 'd-t1' }, svg);
    this.t2 = el('text', { x: C, y: C + 10, class: 'd-t2' }, svg);
    this.t3 = el('text', { x: C, y: C + 28, class: 'd-t3' }, svg);

    this.liveBtn = document.createElement('button');
    this.liveBtn.id = 'btn-time-now';
    this.liveBtn.type = 'button';
    this.liveBtn.className = 'dial-live';
    this.liveBtn.textContent = 'Live';
    this.root.appendChild(this.liveBtn);

    this.bind();
    this.root.classList.remove('active');
    this.raf = requestAnimationFrame(this.tickSpin);
  }

  makeGlyph(svg, isSet) {
    const g = el('g', { class: 'd-glyph', visibility: 'hidden' }, svg);
    el('path', { d: 'M-5 2.5A5 5 0 0 1 5 2.5', class: 'd-glyph-s' }, g);
    el('line', { x1: -8, y1: 2.5, x2: 8, y2: 2.5, class: 'd-glyph-s' }, g);
    el('path', { d: isSet ? 'M0 -9l0 -0.01M-2.5 -6.5L0 -4.5L2.5 -6.5' : 'M-2.5 -7L0 -9.5L2.5 -7', class: 'd-glyph-s' }, g);
    return g;
  }

  /** Brighten now; fall back to the idle ghost after IDLE_MS unless held (hover/drag/scrub). */
  wake() {
    this.root.classList.add('active');
    clearTimeout(this.idleTimer);
    if (this.hovering || this.pointerId !== null || this.scrubbing) return;
    this.idleTimer = setTimeout(() => {
      if (this.hovering || this.pointerId !== null || this.scrubbing) return;
      this.root.classList.remove('active');
    }, IDLE_MS);
  }

  bind() {
    const stop = (e) => e.stopPropagation();
    const ptrAngle = (e) => {
      const r = this.svg.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      return { a: (Math.atan2(dx, -dy) * 180) / Math.PI, d: Math.hypot(dx, dy) };
    };
    this.onDown = (e) => {
      stop(e);
      if (this.pointerId !== null || (e.button !== undefined && e.button > 0)) return;
      this.pointerId = e.pointerId;
      this.wake();
      try { this.svg.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this.lastAngle = ptrAngle(e).a;
      this.svg.focus({ preventScroll: true });
      this.root.classList.add('dragging');
      this.cb.onBegin?.();
      e.preventDefault();
    };
    this.onMove = (e) => {
      stop(e);
      if (e.pointerId !== this.pointerId) return;
      const { a, d } = ptrAngle(e);
      if (d < 14) return; // angle is noise near the centre
      const delta = wrap180(a - this.lastAngle);
      this.lastAngle = a;
      if (delta) this.cb.onTurn?.(delta);
    };
    this.onUp = (e) => {
      stop(e);
      if (e.pointerId !== this.pointerId) return;
      this.pointerId = null;
      this.root.classList.remove('dragging');
      try { this.svg.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this.cb.onEnd?.(); // the dial may coast; scrubbing stays true until it stops
      this.wake();
    };
    this.onWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.wake();
      if (!this.wheelActive) { this.wheelActive = true; this.cb.onBegin?.({ coast: false }); }
      const raw = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      this.cb.onTurn?.(Math.max(-WHEEL_MAX_DEG, Math.min(WHEEL_MAX_DEG, raw * WHEEL_PER_PX)));
      clearTimeout(this.wheelTimer);
      this.wheelTimer = setTimeout(() => { this.wheelActive = false; this.cb.onEnd?.(); }, 180);
    };
    this.onKey = (e) => {
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      e.stopPropagation();
      this.wake();
      if (!this.keyActive) { this.keyActive = true; this.cb.onBegin?.({ coast: false }); }
      this.cb.onTurn?.(dir * (e.shiftKey ? KEY_DEG * 4 : KEY_DEG));
      clearTimeout(this.keyTimer);
      this.keyTimer = setTimeout(() => { this.keyActive = false; this.cb.onEnd?.(); }, 250);
    };
    this.onEnter = () => { this.hovering = true; this.wake(); };
    this.onLeave = () => { this.hovering = false; this.wake(); };
    this.onLiveClick = (e) => { e.stopPropagation(); this.cb.onLive?.(); };

    this.root.addEventListener('pointerenter', this.onEnter);
    this.root.addEventListener('pointerleave', this.onLeave);
    this.svg.addEventListener('pointerdown', this.onDown);
    this.svg.addEventListener('pointermove', this.onMove);
    this.svg.addEventListener('pointerup', this.onUp);
    this.svg.addEventListener('pointercancel', this.onUp);
    this.svg.addEventListener('wheel', this.onWheel, { passive: false });
    this.svg.addEventListener('keydown', this.onKey);
    this.liveBtn.addEventListener('click', this.onLiveClick);
    this.liveBtn.addEventListener('pointerdown', stop);
    this.liveBtn.addEventListener('pointerup', stop);
  }

  tickSpin = (now) => {
    if (this.disposed) return;
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;
    const target = this.scrubbing ? -24 : -1.5;
    this.spinSpeed += (target - this.spinSpeed) * Math.min(1, dt * 4);
    this.spin = (this.spin + this.spinSpeed * dt) % 360;
    this.rune.setAttribute('transform', `rotate(${this.spin.toFixed(2)} ${C} ${C})`);
    this.raf = requestAnimationFrame(this.tickSpin);
  };

  placeGlyph(g, date, s) {
    if (!date) { g.setAttribute('visibility', 'hidden'); return; }
    const span = s.windowEnd - s.windowStart;
    const deg = ((date - s.windowStart) / span) * 360;
    if (!(deg >= 0 && deg <= 360)) { g.setAttribute('visibility', 'hidden'); return; }
    const [x, y] = pt(R_TRACK - 17, deg);
    g.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    g.setAttribute('visibility', 'visible');
  }

  render(s, nightMode = false) {
    if (this.disposed || !s) return;
    this.root.classList.toggle('night', !!nightMode);
    const was = this.scrubbing;
    this.root.classList.toggle('scrubbing', !!s.scrubbing);
    this.scrubbing = !!s.scrubbing;
    if (this.scrubbing) this.wake(); // XR / keyboard / coasting scrubs also light the dial
    else if (was) this.wake();       // start the fade-back timer once motion stops
    this.liveBtn.classList.toggle('is-live', !!s.isLive);

    const ang = Math.max(0, Math.min(360, s.dialAngleDeg || 0));
    const [l1, l2 = ''] = String(s.label || '').split(' · ');
    const res = s.edge && s.edge !== 'none' ? Math.max(0, Math.min(1, s.resistance || 0)) : 0;
    const key = [ang.toFixed(1), l1, l2, s.relLabel, res.toFixed(2), s.edge,
      +s.windowStart, +s.windowEnd, +s.sunset, +s.sunrise].join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.needle.setAttribute('transform', `rotate(${ang.toFixed(2)} ${C} ${C})`);
    this.progress.setAttribute('d', ang > 0.5 ? arcPath(R_TRACK, 0, ang) : '');
    if (s.sunset && s.sunrise) {
      const span = s.windowEnd - s.windowStart;
      const a0 = Math.max(0, ((s.sunset - s.windowStart) / span) * 360);
      const a1 = Math.min(360, ((s.sunrise - s.windowStart) / span) * 360);
      this.night.setAttribute('d', a1 > a0 ? arcPath(R_TRACK, a0, a1) : '');
    } else {
      this.night.setAttribute('d', '');
    }

    this.t1.textContent = l1;
    this.t2.textContent = l2;
    this.t3.textContent = s.relLabel || '';
    this.edgeRing.style.opacity = res.toFixed(2);
    this.edgeRing.style.strokeWidth = (2 + res * 8).toFixed(1);
    this.root.style.setProperty('--res', res.toFixed(2));
    this.hintEl.textContent = res > 0.05
      ? (s.edge === 'end' ? 'keep turning → next day' : '← previous day')
      : '';
    this.hintEl.classList.toggle('show', res > 0.05);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.wheelTimer);
    clearTimeout(this.keyTimer);
    clearTimeout(this.idleTimer);
    this.root.removeEventListener('pointerenter', this.onEnter);
    this.root.removeEventListener('pointerleave', this.onLeave);
    this.svg.removeEventListener('pointerdown', this.onDown);
    this.svg.removeEventListener('pointermove', this.onMove);
    this.svg.removeEventListener('pointerup', this.onUp);
    this.svg.removeEventListener('pointercancel', this.onUp);
    this.svg.removeEventListener('wheel', this.onWheel);
    this.svg.removeEventListener('keydown', this.onKey);
    this.liveBtn.removeEventListener('click', this.onLiveClick);
    this.root.innerHTML = '';
    this.root.classList.remove('dial-root', 'active');
  }
}
