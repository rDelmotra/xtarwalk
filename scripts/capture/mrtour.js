// Hands tour: runs the app in a real WebXR session emulated by Meta's IWER (window.__dev = IWER XRDevice,
// hand-tracking mode). The head and both hands are posed every frame; pinches and wrist twists go through the
// app's own XR input code (select, twist-to-scrub, left-hand tap for real-sky mode). Nothing is faked on screen.
(() => {
  const xw = window.__xw;
  const dev = window.__dev;
  const V3 = xw.camera.position.constructor;
  const Q = xw.camera.quaternion.constructor;
  const D2R = Math.PI / 180;
  const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const seg = (s, a, b) => ease((s - a) / (b - a));
  const lerp = (a, b, k) => a + (b - a) * k;
  const lerpAz = (a, b, k) => a + ((((b - a) % 360) + 540) % 360 - 180) * k;
  const dirAzAlt = (az, alt) => new V3(Math.cos(alt * D2R) * Math.sin(az * D2R), Math.sin(alt * D2R), -Math.cos(alt * D2R) * Math.cos(az * D2R));
  const EYE = new V3(0, 1.6, 0);
  const TW = Number(window.__TWIST ?? 44); // degrees per twist (two ratchets)

  let capEl, endEl, caps, total, star;
  function starDir(name) {
    const S = xw.skyScene, st = S.catalog.stars, P = xw.snapshot.starPositions;
    const i = st.findIndex((s) => s.name === name);
    const v = new V3(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    S.celestialGroup.localToWorld(v);
    return v.sub(EYE).normalize();
  }
  function init() {
    capEl = document.createElement('div'); capEl.className = 'tour-cap'; document.body.appendChild(capEl);
    endEl = document.createElement('div'); endEl.className = 'tour-end'; document.body.appendChild(endEl);
    const tag = document.createElement('div'); tag.className = 'tour-tag';
    tag.textContent = 'SIMULATED MR \u00b7 real sky photo (ESO/S. Brunier) in place of passthrough';
    document.body.appendChild(tag);
    star = starDir('Betelgeuse');
    const a = azAltOf(star);
    window.__mrHead = [[0, a.az - 40, a.alt + 2], [4, a.az - 14, a.alt], [9.5, a.az - 4, a.alt], [14, a.az, a.alt], [20, a.az + 12, a.alt + 4]];
    caps = [
      [0.4, 4.2, 'Mixed reality', 'through the headset, just the real night sky'],
      [5.0, 9.6, 'Left-hand tap: the guide appears', 'drawn onto the real stars'],
      [10.2, 14.6, 'Point and pinch any star', 'Betelgeuse, a red supergiant in Orion'],
      [15.6, 19.4, 'Tap again: only the sky', '']
    ];
    total = 20;
    const m = xw.skyScene._bodyByName.get('Moon')?.target;
    if (m) xw.simulatePush?.(m.alt, m.az); // calibrated before the clip starts: no push hint
    xw.toggleRealSky(true);
    return total;
  }
  const azAltOf = (d) => ({ az: (Math.atan2(d.x, -d.z) / D2R + 360) % 360, alt: Math.asin(d.y) / D2R });
  function headAt(s) {
    const k = window.__mrHead; let i = 0; while (i < k.length - 2 && s > k[i + 1][0]) i++;
    const [t0, a0, b0] = k[i], [t1, a1, b1] = k[i + 1]; const u = seg(s, t0, t1);
    return { az: lerpAz(a0, a1, u), alt: lerp(b0, b1, u) };
  }
  /** A hand pose relative to the head's yaw frame: right/up/forward offsets in metres. */
  function placeHand(hand, head, off, aimDir, twistDeg, pinch, s) {
    // offsets are in the HEAD frame (yaw and pitch), so a raised hand stays in view when you look up
    const qy = new Q().setFromAxisAngle(new V3(0, 1, 0), -head.az * D2R).multiply(new Q().setFromAxisAngle(new V3(1, 0, 0), head.alt * D2R));
    const p = new V3(off[0], off[1], -off[2]).applyQuaternion(qy).add(EYE);
    // a little life: slow, tiny drift so the hand never freezes like a mannequin
    p.x += 0.004 * Math.sin(s * 1.3 + off[0] * 10); p.y += 0.003 * Math.sin(s * 1.7 + 1); p.z += 0.003 * Math.sin(s * 1.1 + 2);
    hand.position.set(p.x, p.y, p.z);
    const d = aimDir ? aimDir.clone().normalize() : new V3(0, 0, -1).applyQuaternion(qy);
    const q = new Q().setFromUnitVectors(new V3(0, 0, -1), d);
    if (twistDeg) q.premultiply(new Q().setFromAxisAngle(d, twistDeg * D2R));
    hand.quaternion.set(q.x, q.y, q.z, q.w);
    hand.updatePinchValue(Math.max(0, Math.min(1, pinch)));
  }
  const pulse = (s, t, len = 0.35) => (s < t || s > t + len ? 0 : Math.sin(((s - t) / len) * Math.PI)); // quick pinch 0->1->0
  const hold = (s, a, b, ramp = 0.12) => Math.min(seg(s, a, a + ramp), 1 - seg(s, b - ramp, b));

  function at(s) {
    const head = headAt(s);
    const qh = new Q().setFromAxisAngle(new V3(0, 1, 0), -head.az * D2R).multiply(new Q().setFromAxisAngle(new V3(1, 0, 0), head.alt * D2R));
    dev.quaternion.set(qh.x, qh.y, qh.z, qh.w);
    const fwd = dirAzAlt(head.az, head.alt);
    const R = dev.hands.right, L = dev.hands.left;
    const down = [0.2, -0.62, 0.15], lDown = [-0.2, -0.62, 0.15];
    const lift = (base, a, b, pos) => { const k = Math.min(seg(s, a, a + 0.9), 1 - seg(s, b - 0.9, b)); return base.map((v, i) => lerp(v, pos[i], k)); };
    let rOff = down, rAim = null, rPinch = 0;
    if (s > 9.6 && s < 15) { rOff = lift(down, 9.6, 15, [0.2, -0.2, 0.42]); rAim = star; rPinch = pulse(s, 11.6, 0.4); }
    placeHand(R, head, rOff, rAim, 0, rPinch, s);
    let lOff = lDown, lPinch = 0;
    if (s > 3.2 && s < 6.6) { lOff = lift(lDown, 3.2, 6.6, [-0.2, -0.22, 0.4]); lPinch = pulse(s, 4.6, 0.35); }
    else if (s > 14.4 && s < 17.8) { lOff = lift(lDown, 14.4, 17.8, [-0.2, -0.22, 0.4]); lPinch = pulse(s, 15.6, 0.35); }
    placeHand(L, head, lOff, fwd.clone().add(new V3(0, 0.12, 0)).normalize(), 0, lPinch, s);
    let txt = null, a = 0;
    for (const [c0, c1, title, sub] of caps) if (s >= c0 && s <= c1) { txt = [title, sub]; a = Math.min(1, (s - c0) / 0.6, (c1 - s) / 0.6); }
    if (txt) { const html = `${txt[0]}${txt[1] ? `<small>${txt[1]}</small>` : ''}`; if (capEl.innerHTML !== html) capEl.innerHTML = html; }
    capEl.style.opacity = String(Math.max(0, a));
    endEl.style.opacity = '1';
    endEl.style.background = `rgba(4,7,12,${Math.max(1 - s / 0.6, (s - 19.3) / 0.7, 0)})`;
  }
  window.__tour = { init, at };
})();
