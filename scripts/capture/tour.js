// The scripted tour, injected into the running app by record.mjs. __tour.at(seconds) is called once per frame
// (in order) and drives the real app through its own controls: camera look, selection, the time dial,
// real-sky mode and night mode. Nothing here is faked: every frame is the app rendering itself.
(() => {
  const xw = window.__xw;
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const lerp = (a, b, k) => a + (b - a) * k;
  const lerpAz = (a, b, k) => { let d = ((b - a + 540) % 360) - 180; return a + d * k; };

  let shots = [];   // camera keyframes [t, az, alt, fov]
  let events = [];  // [t, fn] fired once
  let caps = [];    // [t0, t1, title, sub]
  let total = 0;
  let baseFov = 60;
  let capEl, endEl;

  function bodyAzAlt(name) {
    const e = xw.skyScene._bodyByName.get(name);
    return e ? { az: e.target.az, alt: e.target.alt } : null;
  }

  function init() {
    const cam = xw.camera;
    baseFov = cam.fov;
    capEl = document.createElement('div'); capEl.className = 'tour-cap'; document.body.appendChild(capEl);
    endEl = document.createElement('div'); endEl.className = 'tour-end';
    endEl.innerHTML = 'XTARWALK<small>a live sky guide for Meta Quest &middot; WebXR</small>';
    document.body.appendChild(endEl);

    const moon = bodyAzAlt('Moon') ?? { az: 200, alt: 40 };
    // the brightest planet that is up (not the Moon/Sun), for the real-sky tap
    const planets = xw.skyScene._bodyEntries.map((e) => e.target)
      .filter((t) => !['Moon', 'Sun'].includes(t.name) && t.alt > 12).sort((a, b) => (a.mag ?? 9) - (b.mag ?? 9));
    const planet = planets[0] ?? null;
    const P = planet ?? { name: 'Moon', ...moon };

    shots = [
      [0, moon.az - 70, 18, baseFov],
      [5, moon.az - 8, moon.alt - 2, baseFov],
      [7.5, moon.az, moon.alt, 20],
      [10.5, moon.az, moon.alt, 20],
      [12.5, 0, 30, baseFov + 6],   // toward the pole for the trails
      [21, 0, 30, baseFov + 6],
      [24, 95, 14, baseFov + 4],    // dawn in the east
      [26.5, 95, 14, baseFov + 4],
      [29, 75, 42, baseFov - 8],    // constellations where you look (back to tonight)
      [33, 60, 48, baseFov - 8],
      [35, P.az, P.alt, baseFov - 14],
      [41, P.az, P.alt, baseFov - 14],
      [43, P.az + 25, Math.max(25, P.alt - 5), baseFov],
      [50, P.az + 40, Math.max(25, P.alt), baseFov]
    ];
    const turnPerFrame = 0.178; // deg/frame at 30 fps; desktop gain 12 min/deg -> ~72 min of sky per second
    events = [
      [7.6, () => xw.selectByName('Moon')],
      [12.6, () => xw.dial.begin({ coast: false })],
      [21.4, () => xw.dial.end()],
      [26.6, () => xw.action('timeNow')],
      [27, () => xw.action('timeNow')],
      [34.4, () => xw.toggleRealSky(true)],
      [36.5, () => xw.selectByName(P.name)],
      [40.6, () => xw.toggleRealSky(false)],
      [43.2, () => xw.action('night')],
      [46.4, () => xw.action('night')]
    ];
    // continuous dial turning between begin and end (registered as a per-frame event range)
    events.push([12.7, null, { until: 21.3, perFrame: () => xw.dial.turn(turnPerFrame) }]);
    caps = [
      [0.4, 5.6, 'Xtarwalk', 'the live sky, wherever you look'],
      [6.2, 11.6, 'Point and pinch to inspect', 'the real Moon, lit by the real Sun'],
      [12.8, 20.8, 'Twist your wrist to travel through the night', 'every star leaves its trail'],
      [21.8, 26.4, 'Dawn, through a physically based atmosphere', ''],
      [27.4, 33.8, 'Constellations draw themselves where you look', 'and fade away when you look elsewhere'],
      [34.6, 40.4, 'Real-sky mode: only the real sky', `tap ${P.name} and it is named; each tap fine-tunes the alignment`],
      [42.6, 46.6, 'Night vision', 'red light keeps your eyes dark-adapted'],
    ];
    total = 51;
    return total;
  }

  const fired = new Set();
  function at(s) {
    // camera
    let i = 0;
    while (i < shots.length - 2 && s > shots[i + 1][0]) i++;
    const [t0, az0, al0, f0] = shots[i];
    const [t1, az1, al1, f1] = shots[i + 1];
    const k = ease(Math.min(1, Math.max(0, (s - t0) / Math.max(1e-6, t1 - t0))));
    xw.look(lerpAz(az0, az1, k), lerp(al0, al1, k));
    const fov = lerp(f0, f1, k);
    if (Math.abs(xw.camera.fov - fov) > 1e-3) { xw.camera.fov = fov; xw.camera.updateProjectionMatrix(); }
    // events
    for (let j = 0; j < events.length; j++) {
      const [te, fn, range] = events[j];
      if (range) { if (s >= te && s <= range.until) range.perFrame(); continue; }
      if (s >= te && !fired.has(j)) { fired.add(j); fn(); }
    }
    // captions
    let txt = null, a = 0;
    for (const [c0, c1, title, sub] of caps) {
      if (s >= c0 && s <= c1) { txt = [title, sub]; a = Math.min(1, (s - c0) / 0.6, (c1 - s) / 0.6); }
    }
    if (txt) {
      const html = `${txt[0]}${txt[1] ? `<small>${txt[1]}</small>` : ''}`;
      if (capEl.innerHTML !== html) capEl.innerHTML = html;
    }
    capEl.style.opacity = String(Math.max(0, a));
    endEl.style.opacity = String(Math.min(1, Math.max(0, (s - 47.4) / 1.2)));
    endEl.style.background = `rgba(4,7,12,${0.82 * Math.min(1, Math.max(0, (s - 47.2) / 1.4))})`;
  }

  window.__tour = { init, at };
})();
