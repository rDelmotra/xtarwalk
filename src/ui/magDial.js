// Minimal "star depth" dial (limiting magnitude) for desktop/phone, centred in the left third.
// Same language as the time dial: one hairline arc, a thin value arc, a needle dot, the number.
// Drag around it / scroll / arrow keys to show fainter (clockwise) or only brighter stars.
import { MAG_MIN, MAG_MAX } from '../sky/magLimit.js';

const NS = 'http://www.w3.org/2000/svg';
const C = 110;
const R = 80;
const A0 = -135; // gauge start (deg, 0 = top, clockwise)
const A1 = 135;
const IDLE_MS = 2500;

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
  const [x0, y0] = pt(r, a0);
  const [x1, y1] = pt(r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};
const magToAng = (m) => A0 + ((m - MAG_MIN) / (MAG_MAX - MAG_MIN)) * (A1 - A0);
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

export class MagDial {
  constructor(containerEl, { onTurn, onAuto }) {
    this.root = containerEl;
    this.cb = { onTurn, onAuto };
    this.pointerId = null;
    this.lastAngle = 0;
    this.hovering = false;
    this.idleTimer = 0;
    this.lastKey = '';
    this.root.classList.add('dial-root');

    const svg = el('svg', { viewBox: '0 0 220 220', class: 'dial-svg', tabindex: '0', role: 'slider',
      'aria-label': 'Star depth: drag around, scroll, or use arrow keys' });
    this.svg = svg;
    this.root.appendChild(svg);
    el('path', { class: 'd-ring-thin', d: arcPath(R, A0, A1) }, svg);
    this.progress = el('path', { class: 'd-progress', d: '' }, svg);
    this.autoTick = el('line', { class: 'd-tick major' }, svg);
    this.needle = el('circle', { r: 3.2, class: 'd-needle-dot' }, svg);
    this.t1 = el('text', { x: C, y: C - 14, class: 'd-t1' }, svg);
    this.t2 = el('text', { x: C, y: C + 10, class: 'd-t2' }, svg);
    this.t3 = el('text', { x: C, y: C + 28, class: 'd-t3' }, svg);
    this.t1.textContent = 'Star depth';

    this.autoBtn = document.createElement('button');
    this.autoBtn.type = 'button';
    this.autoBtn.className = 'dial-live';
    this.autoBtn.textContent = 'Auto';
    this.root.appendChild(this.autoBtn);

    const stop = (e) => e.stopPropagation();
    const ang = (e) => {
      const r = this.svg.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      return { a: (Math.atan2(dx, -dy) * 180) / Math.PI, d: Math.hypot(dx, dy) };
    };
    svg.addEventListener('pointerdown', (e) => {
      stop(e);
      if (this.pointerId !== null) return;
      this.pointerId = e.pointerId;
      try { svg.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this.lastAngle = ang(e).a;
      this.wake();
      e.preventDefault();
    });
    svg.addEventListener('pointermove', (e) => {
      stop(e);
      if (e.pointerId !== this.pointerId) return;
      const { a, d } = ang(e);
      if (d < 14) return;
      const delta = wrap180(a - this.lastAngle);
      this.lastAngle = a;
      if (delta) this.cb.onTurn?.(delta);
    });
    const up = (e) => { stop(e); if (e.pointerId === this.pointerId) { this.pointerId = null; this.wake(); } };
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    svg.addEventListener('wheel', (e) => {
      e.preventDefault(); e.stopPropagation(); this.wake();
      const raw = (e.deltaY || e.deltaX) * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      this.cb.onTurn?.(Math.max(-14, Math.min(14, raw * 0.08)));
    }, { passive: false });
    svg.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
      if (!dir) return;
      e.preventDefault(); e.stopPropagation(); this.wake();
      this.cb.onTurn?.(dir * (e.shiftKey ? 16 : 4));
    });
    this.root.addEventListener('pointerenter', () => { this.hovering = true; this.wake(); });
    this.root.addEventListener('pointerleave', () => { this.hovering = false; this.wake(); });
    this.autoBtn.addEventListener('pointerdown', stop);
    this.autoBtn.addEventListener('pointerup', stop);
    this.autoBtn.addEventListener('click', (e) => { stop(e); this.cb.onAuto?.(); });
  }

  wake() {
    this.root.classList.add('active');
    clearTimeout(this.idleTimer);
    if (this.hovering || this.pointerId !== null) return;
    this.idleTimer = setTimeout(() => {
      if (!this.hovering && this.pointerId === null) this.root.classList.remove('active');
    }, IDLE_MS);
  }

  /** @param {{limit:number, auto:number, isAuto:boolean, labels:{main:string, sub:string}}} m */
  render(m, { externalTurn = false } = {}) {
    if (externalTurn) this.wake(); // XR left-hand twist also lights it up
    const key = `${m.limit.toFixed(2)}|${m.auto.toFixed(2)}|${m.isAuto}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const a = magToAng(m.limit);
    this.progress.setAttribute('d', a - A0 > 0.5 ? arcPath(R, A0, a) : '');
    const [nx, ny] = pt(R, a);
    this.needle.setAttribute('cx', nx.toFixed(2));
    this.needle.setAttribute('cy', ny.toFixed(2));
    const aa = magToAng(m.auto);
    const [x0, y0] = pt(R + 4, aa);
    const [x1, y1] = pt(R - 4, aa);
    this.autoTick.setAttribute('x1', x0); this.autoTick.setAttribute('y1', y0);
    this.autoTick.setAttribute('x2', x1); this.autoTick.setAttribute('y2', y1);
    this.t2.textContent = m.limit.toFixed(1);
    this.t3.textContent = m.isAuto ? 'AUTO' : m.labels.sub.toUpperCase();
    this.autoBtn.classList.toggle('is-live', m.isAuto);
  }
}
