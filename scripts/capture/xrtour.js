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

  let capEl, endEl, moon, P, caps, total;

  function worldDirOf(name) {
    const e = xw.skyScene._bodyByName.get(name);
    const p = new V3(); e.mesh.getWorldPosition(p);
    return p.sub(EYE).normalize();
  }
  const azAltOf = (d) => ({ az: (Math.atan2(d.x, -d.z) / D2R + 360) % 360, alt: Math.asin(d.y) / D2R });

  function init() {
    capEl = document.createElement('div'); capEl.className = 'tour-cap'; document.body.appendChild(capEl);
    endEl = document.createElement('div'); endEl.className = 'tour-end';
    endEl.innerHTML = 'XTARWALK<small>a live sky guide for Meta Quest &middot; WebXR</small>';
    document.body.appendChild(endEl);
    moon = azAltOf(worldDirOf('Moon'));
    const planets = xw.skyScene._bodyEntries.map((e) => e.target)
      .filter((t) => !['Moon', 'Sun'].includes(t.name) && t.alt > 15).sort((a, b) => (a.mag ?? 9) - (b.mag ?? 9));
    P = planets[0] ? { name: planets[0].name, ...azAltOf(worldDirOf(planets[0].name)) } : { name: 'Moon', ...moon };
    caps = [
      [0.4, 4.6, 'Xtarwalk on Meta Quest', 'the live sky, wherever you look'],
      [5.0, 10.4, 'Point and pinch to inspect', 'the real Moon, lit by the real Sun'],
      [12.4, 21.2, 'Pinch and twist your wrist to travel through the night', 'every star leaves its trail'],
      [21.8, 26.2, 'Dawn, through a physically based atmosphere', ''],
      [27.2, 31.2, 'Constellations draw themselves where you look', ''],
      [31.6, 37.6, 'Left-hand tap: real-sky mode', `only the real sky; tap ${P.name} and it is named`],
      [38.6, 42.2, 'Night vision', 'red light keeps your eyes dark-adapted']
    ];
    total = 47;
    // the sky is calibrated before the tour starts (a two-palm push on the Moon), so the hint stays away
    xw.simulatePush?.(moon.alt, moon.az);
    return total;
  }

  // head: [t, az, alt]
  const headKeys = () => [
    [0, moon.az - 55, 12], [4.5, moon.az - 6, moon.alt - 6], [10, moon.az - 4, moon.alt - 6],
    [12, 0, 32], [21, 0, 32], [23.5, 100, 8], [26.4, 100, 8],
    [28.2, 70, 40], [31, 58, 44], [33, P.az, P.alt - 6], [38, P.az, P.alt - 6], [42, P.az + 25, P.alt], [47, P.az + 35, P.alt + 4]
  ];
  function headAt(s) {
    const k = headKeys();
    let i = 0; while (i < k.length - 2 && s > k[i + 1][0]) i++;
    const [t0, a0, b0] = k[i], [t1, a1, b1] = k[i + 1];
    const u = seg(s, t0, t1);
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

  const fired = new Set();
  const once = (key, s, t, fn) => { if (s >= t && !fired.has(key)) { fired.add(key); fn(); } };

  function at(s) {
    const head = headAt(s);
    dev.quaternion.set(...(() => { const q = new Q().setFromAxisAngle(new V3(0, 1, 0), -head.az * D2R).multiply(new Q().setFromAxisAngle(new V3(1, 0, 0), head.alt * D2R)); return [q.x, q.y, q.z, q.w]; })());
    const fwd = dirAzAlt(head.az, head.alt);
    const R = dev.hands.right, L = dev.hands.left;

    // ---------------- right hand ----------------
    const down = [0.2, -0.62, 0.15];
    let rOff = down, rAim = null, rTwist = 0, rPinch = 0;
    const up = (a, b, pos) => { const k = Math.min(seg(s, a, a + 0.9), 1 - seg(s, b - 0.9, b)); return down.map((v, i) => lerp(v, pos[i], k)); };
    const relHead = (dx, dy) => { const q = new Q().setFromAxisAngle(new V3(0, 1, 0), -head.az * D2R).multiply(new Q().setFromAxisAngle(new V3(1, 0, 0), head.alt * D2R)); return [dx, dy]; };
    if (s > 4 && s < 10.5) { // point at the Moon and pinch
      rOff = up(4, 10.5, [0.2, -0.2, 0.42]);
      rAim = worldDirOf('Moon').sub(new V3(0.2, -0.2, 0).multiplyScalar(0.02));
      rPinch = pulse(s, 6.4, 0.4);
    } else if (s > 11.6 && s < 21.4) { // pinch on open sky and twist, twice (ratchet)
      rOff = up(11.6, 21.4, [0.16, -0.22, 0.4]);
      rAim = fwd.clone().add(new V3(0, 0.1, 0)).normalize();
      rPinch = hold(s, 12.6, 16.6) + hold(s, 17.2, 20.6);
      rTwist = s < 16.6 ? TW * seg(s, 12.8, 16.4) : s < 17.2 ? TW * (1 - seg(s, 16.6, 17.15)) : TW * seg(s, 17.4, 20.4);
    } else if (s > 32 && s < 37.4) { // real sky: point at the planet and tap
      rOff = up(32, 37.4, [0.2, -0.2, 0.42]);
      rAim = worldDirOf(P.name);
      rPinch = pulse(s, 34.4, 0.4);
    }
    placeHand(R, head, rOff, rAim, rTwist, rPinch, s);

    // ---------------- left hand ----------------
    const lDown = [-0.2, -0.62, 0.15];
    let lOff = lDown, lPinch = 0;
    const lUp = (a, b, pos) => { const k = Math.min(seg(s, a, a + 0.9), 1 - seg(s, b - 0.9, b)); return lDown.map((v, i) => lerp(v, pos[i], k)); };
    if (s > 30.6 && s < 33.6) { lOff = lUp(30.6, 33.6, [-0.2, -0.22, 0.4]); lPinch = pulse(s, 31.9, 0.35); }
    else if (s > 36.6 && s < 39.6) { lOff = lUp(36.6, 39.6, [-0.2, -0.22, 0.4]); lPinch = pulse(s, 37.9, 0.35); }
    placeHand(L, head, lOff, fwd.clone().add(new V3(0, 0.12, 0)).normalize(), 0, lPinch, s);

    // ---------------- app actions that have no hand gesture of their own ----------------
    once('live', s, 26.4, () => xw.action('timeNow'));
    once('live2', s, 26.8, () => xw.action('timeNow'));
    once('night1', s, 39.2, () => xw.action('night'));
    once('night2', s, 42.4, () => xw.action('night'));

    // captions + end card
    let txt = null, a = 0;
    for (const [c0, c1, title, sub] of caps) if (s >= c0 && s <= c1) { txt = [title, sub]; a = Math.min(1, (s - c0) / 0.6, (c1 - s) / 0.6); }
    if (txt) { const html = `${txt[0]}${txt[1] ? `<small>${txt[1]}</small>` : ''}`; if (capEl.innerHTML !== html) capEl.innerHTML = html; }
    capEl.style.opacity = String(Math.max(0, a));
    endEl.style.opacity = String(Math.min(1, Math.max(0, (s - 43.6) / 1.2)));
    endEl.style.background = `rgba(4,7,12,${0.82 * Math.min(1, Math.max(0, (s - 43.4) / 1.4))})`;
  }

  window.__tour = { init, at };
})();
