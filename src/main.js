import * as THREE from 'three';
import { loadSkyCatalog, computeSkySnapshot } from './astro/skyEngine.js';
import { SkyCalibrator } from './calibration/calibration.js';
import { SkyScene } from './scene/skyScene.js';
import { SpatialInfoCard } from './scene/labels.js';
import { SpatialHudPanel } from './xr/hudPanel.js';
import { XRInputManager } from './xr/handInput.js';
import { Wayfinder } from './xr/wayfinder.js';
import { TimeDial, GAIN_XR } from './time/timeDial.js';
import { AimReticle } from './ui/aimReticle.js';
import { MagDial } from './ui/magDial.js';
import { MagControl, autoLimit } from './sky/magLimit.js';
import { DesktopDial } from './ui/desktopDial.js';
import { AgamottoRing } from './xr/agamottoRing.js';
import { Satellites } from './sat/satellites.js';
import { RefineSession, yawOf } from './calibration/skyFit.js';
import { identifyTaps } from './calibration/twoPoint.js';
import { SkyPhoto } from './scene/skyPhoto.js';
import { PushAlign } from './xr/pushAlign.js'; // [Engineer D] push-gesture auto-align
import { initSimulatorIfRequested, runAutomatedVrDemo } from './xr/simulator.js';

const state = {
  lat: 28.6139,
  lon: 77.2090,
  locationLabel: 'Delhi (default)',
  timeOffsetHours: 0,
  showConstellations: true,
  showSatellites: true,
  realSky: false,
  nightMode: false,
  selectedTarget: null,
  calibrating: false,
  calStep: 'idle', // 'idle' | 'choose' | 'point' | 'tap' (guided point-at-two-objects)
  calTaps: [],
  calRealSkyWas: false,
  calTargetName: null,
  finding: 'idle', // 'idle' | 'choose' | 'tracking'
  findName: null,
  inXR: false,
  isAR: false
};

const statusEl = document.getElementById('status-line');
const infoCardEl = document.getElementById('info-card');
const calHintEl = document.getElementById('cal-hint');
const btnAr = document.getElementById('btn-ar');
const btnVr = document.getElementById('btn-vr');
const btnCal = document.getElementById('btn-calibrate');
const btnFind = document.getElementById('btn-find');
const btnLines = document.getElementById('btn-constellations');
const btnSats = document.getElementById('btn-satellites');
const btnNight = document.getElementById('btn-night');
const btnResetAlign = document.getElementById('btn-reset-align');

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// Soft light for the tracked-hand meshes (everything in the sky uses unlit shaders; without this the hands are black)
scene.add(new THREE.HemisphereLight(0xcfe3ff, 0x1a2230, 1.6));
{ const key = new THREE.DirectionalLight(0xffffff, 1.2); key.position.set(0.4, 1, 0.6); scene.add(key); }
scene.background = new THREE.Color(0x02040a);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 250);
camera.position.set(0, 0, 0);

const calibrator = new SkyCalibrator();
calibrator.loadSaved();
// Real-sky taps refine the alignment beyond yaw: each tap on a real object is an observation (where we computed
// it vs where the hand pointed); 2+ of them fit a full 3-axis rotation (skyFit.js). trim = that fit minus yaw.
const refine = new RefineSession({ maxPairs: 8, outlierDeg: 4, maxTiltDeg: 3 });
const trimQ = new THREE.Quaternion();
const trimTarget = new THREE.Quaternion();
const _yawQ = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);
function resetRefine() { refine.reset(); trimTarget.identity(); }
{ // any other calibration (choose-and-point, two-palm push, reset) starts the refinement over
  const snap = calibrator.snapToTarget.bind(calibrator);
  calibrator.snapToTarget = (...a) => { resetRefine(); return snap(...a); };
  const reset = calibrator.reset.bind(calibrator);
  calibrator.reset = (...a) => { resetRefine(); if (a[0]) trimQ.identity(); return reset(...a); };
} // desktop starts with the saved yaw; XR sessions reset it (see startXR)
calHintEl.textContent = `Calibration: ${calibrator.getOffsetDegrees().toFixed(1)}° offset`;
const spatialCard = new SpatialInfoCard();
const CARD_SECONDS = 7; // the XR info card fades out on its own; select again to bring it back
const _cardV = new THREE.Vector3();
const _cardR = new THREE.Vector3();
{ const show = spatialCard.show.bind(spatialCard); spatialCard.show = (...a) => { spatialCard.shownAt = performance.now(); return show(...a); }; }
scene.add(spatialCard.mesh);

let catalog = null;
let skyScene = null;
let lastSnapshot = null;

const hudPanel = new SpatialHudPanel((action) => handleAction(action));
scene.add(hudPanel.group);

const wayfinder = new Wayfinder(scene);
wayfinder.onFound = (name) => completeFind(name);

function currentDate() {
  return new Date(Date.now() + state.timeOffsetHours * 3600 * 1000);
}

/** The time the sky is currently showing (live preview while scrubbing, else the committed offset). */
function displayDate() {
  return previewActive && dialState?.date ? dialState.date : currentDate();
}

// ---- Satellites overlay ----
let satellites = null;
let lastSatMs = 0;
function updateSatellites(force = false) {
  if (!satellites?.points) return;
  const now = performance.now();
  if (!force && now - lastSatMs < 250) return; // ~4 Hz
  lastSatMs = now;
  satellites.setObserver(state.lat, state.lon, 0);
  satellites.setDayVisibility((skyScene?.dayVisibility ?? 1) * (skyScene?.overlayFactor ?? 1));
  satellites.update(displayDate());
  const sel = state.selectedTarget;
  if (sel && sel.kind === 'satellite' && !state.inXR && state.calStep === 'idle' && state.finding === 'idle') showSatInfo(sel);
}
function showSatInfo(t) {
  updateHtmlInfo(t.name, [t.subtitle, `Alt ${t.alt.toFixed(1)}° • Az ${t.az.toFixed(1)}°`, t.extra].join('<br/>'));
}
async function bootSatellites() {
  try {
    satellites = new Satellites(skyScene.skyRoot);
    await satellites.load();
    satellites.setNightMode(state.nightMode);
    satellites.setVisible(state.showSatellites);
    updateSatellites(true);
  } catch (err) {
    console.warn('Satellites unavailable:', err);
    satellites?.dispose();
    satellites = null;
    btnSats.disabled = true;
    btnSats.classList.remove('active');
    btnSats.title = 'Satellite data unavailable';
  }
}

function refreshSky() {
  if (!catalog || !skyScene) return;
  const date = currentDate();
  lastSnapshot = computeSkySnapshot(catalog, date, state.lat, state.lon);
  skyScene.updateSnapshot(lastSnapshot, state.showConstellations);

  updateSatellites(true);
  updateStatusLine();
}

function updateStatusLine() {
  const s = dialState;
  const when = s.isLive ? s.label : `${s.label} (${s.relLabel})`;
  statusEl.textContent = `${state.locationLabel} • ${when} • 5,044 stars`;
}

// ---- Time dial: model + desktop widget + XR ring (see docs/time-dial-contract.md) ----
const dial = new TimeDial({ lat: state.lat, lon: state.lon });
let dialState = dial.state;
let previewActive = false;
let wasScrubbing = false;
let lastHourMark = 0;
let keyTurnTimer = 0;

const agamottoRing = new AgamottoRing(scene);
// ---- Star depth (limiting magnitude): auto from the sky, LEFT-hand twist / left dial to adjust ----
const magCtl = new MagControl();
const magRing = new AgamottoRing(scene);
let magTwisting = false;
let magLastAuto = 0;
const magDial = new MagDial(document.getElementById('mag-dial'), {
  onTurn: (d) => { magCtl.turn(d); applyMag(); },
  onAuto: () => { magCtl.resetToAuto(); applyMag(); },
  onTap: () => toggleRealSky()
});
function applyMag(external = false) {
  skyScene?.setMagLimit(magCtl.limit);
  magDial.render(magCtl, { externalTurn: external });
}
/** Re-estimate what the eye can see (twilight + moonlight), at most twice a second. */
function updateAutoMag(now) {
  if (!skyScene || now - magLastAuto < 500) return;
  magLastAuto = now;
  magCtl.setAuto(autoLimit({ sunAltDeg: skyScene.sunAlt ?? -30, moonAltDeg: skyScene.moonAlt ?? -10, moonPhase: skyScene.moonPhase ?? 0 }));
  applyMag();
}
/** A DialState-shaped object so the same Agamotto ring can show the star-depth twist. */
function magRingState() {
  const frac = (magCtl.limit - 1) / 5.5;
  return { dialAngleDeg: frac * 270, label: `Star depth · mag ${magCtl.limit.toFixed(1)}`, relLabel: magCtl.labels.sub,
    edge: 'none', resistance: 0, dayShift: 0, scrubbing: magTwisting };
}
const ringAim = new THREE.Object3D();
const magAim = new THREE.Object3D();
const ringPos = new THREE.Vector3();
const ringDir = new THREE.Vector3();
const ringCamPos = new THREE.Vector3();
const supportsPreview = () => skyScene && typeof skyScene.setScrubPreview === 'function';

/** Commit the dial's time as the real sky time (full snapshot) and drop the fast preview. */
function commitDialTime(s) {
  if (!previewActive && state.timeOffsetHours === s.offsetHours) return;
  state.timeOffsetHours = s.offsetHours;
  previewActive = false;
  refreshSky();
  if (supportsPreview() && typeof skyScene.clearScrubPreview === 'function') skyScene.clearScrubPreview();
}

dial.onChange((s) => {
  dialState = s;
  if (s.scrubbing) {
    if (!wasScrubbing) lastHourMark = Math.floor(s.offsetHours);
    if (supportsPreview()) {
      previewActive = true;
      skyScene.setScrubPreview(s.offsetHours - state.timeOffsetHours, s.date);
      updateSatellites();
    }
    updateStatusLine();
    const hour = Math.floor(s.offsetHours);
    if (hour !== lastHourMark) { lastHourMark = hour; handInput?.hapticTick(); }
    if (dial.consumeDayClick()) handInput?.hapticClick();
  } else {
    dial.consumeDayClick();
    commitDialTime(s);
  }
  wasScrubbing = s.scrubbing;
  desktopDial?.render(s, state.nightMode);
});

function dialGoLive() {
  dial.goLive();
  commitDialTime(dial.state);
}

const aimReticle = new AimReticle({ onSelect: (t) => selectTarget(t) });

const desktopDial = new DesktopDial(document.getElementById('time-dial'), {
  onBegin: (o) => dial.begin(o),
  onTurn: (deg) => dial.turn(deg),
  onEnd: () => dial.end(),
  onLive: () => dialGoLive()
});
desktopDial.render(dialState, state.nightMode);

/** Calibrate/Find read unrotated target.pos, so a live scrub must commit first. */
function endScrubForTools() {
  clearTimeout(keyTurnTimer);
  if (dialState.scrubbing) dial.end();
}

function handleAction(action) {
  if ((action === 'calibrate' && state.calStep === 'idle') || (action === 'find' && state.finding === 'idle')) {
    endScrubForTools();
  }
  if (action === 'find') {
    if (state.finding === 'idle') enterFindChoose();
    else exitFind(true);
  } else if (action.startsWith('findpick:')) {
    if (state.finding === 'choose') startFinding(action.slice(9));
  } else if (action === 'calibrate') {
    if (state.finding !== 'idle') exitFind(false);
    if (state.calStep === 'idle') enterTapCalibration();
    else exitCalibration();
  } else if (action === 'resetAlign') {
    calibrator.reset();
    if (!state.inXR) calibrator.save();
    exitCalibration();
    calHintEl.textContent = 'Calibration: 0.0° offset (reset)';
    updateHtmlInfo('Alignment reset', 'Sky yaw is back to the default (true north from the headset/compass).');
  } else if (action.startsWith('ref:')) {
    if (state.calStep === 'choose') enterPointStep(action.slice(4));
  } else if (action === 'timeNow') {
    dialGoLive();
  } else if (action === 'constellations') {
    state.showConstellations = !state.showConstellations;
    btnLines.classList.toggle('active', state.showConstellations);
    hudPanel.setButtonActive('constellations', state.showConstellations);
    refreshSky();
  } else if (action === 'satellites') {
    if (!satellites?.points) return;
    state.showSatellites = !state.showSatellites;
    btnSats.classList.toggle('active', state.showSatellites);
    satellites.setVisible(state.showSatellites);
    if (!state.showSatellites && state.selectedTarget?.kind === 'satellite') clearSatSelection();
  } else if (action === 'night') {
    state.nightMode = !state.nightMode;
    document.body.classList.toggle('night-mode', state.nightMode);
    btnNight.classList.toggle('active', state.nightMode);
    hudPanel.setButtonActive('night', state.nightMode);
    skyScene?.setNightMode(state.nightMode);
    satellites?.setNightMode(state.nightMode);
    desktopDial.render(dialState, state.nightMode);
    if (state.selectedTarget && state.inXR) {
      spatialCard.show(state.selectedTarget, state.nightMode);
    }
  }
}

// ---- Calibration flow: choose reference -> point at the real object -> snap yaw ----

/** Good reference objects currently above the horizon, brightest first (max 6). */
function getReferenceCandidates() {
  if (!lastSnapshot) return [];
  const out = [];
  for (const b of lastSnapshot.solarSystem) {
    if (b.name === 'Sun' || b.alt <= 5) continue;
    if (b.name === 'Moon' || b.mag < 1.5) out.push(b);
  }
  for (const st of lastSnapshot.visibleNamedStars) {
    if (st.alt > 5 && st.mag <= 1.0) out.push(st);
  }
  out.sort((x, y) => x.mag - y.mag);
  // Moon magnitude is ~-12 so it naturally sorts first; dedupe names just in case.
  const seen = new Set();
  return out.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true))).slice(0, 6);
}

function findTargetByName(name) {
  if (!lastSnapshot) return null;
  return lastSnapshot.solarSystem.find((t) => t.name === name)
    || lastSnapshot.visibleNamedStars.find((t) => t.name === name)
    || null;
}

// ---- Find mode: pick a target, follow the wayfinding arrow, reticle, auto-select on arrival ----

const FIND_INFO_DEFAULT = 'Drag to look around • Click / Pinch to inspect • Use "Snap to Sky" to lock North onto any target';

/** Moon, planets and bright named stars above the horizon, brightest first (max 8). */
function getFindCandidates() {
  if (!lastSnapshot) return [];
  const out = [];
  for (const b of lastSnapshot.solarSystem) {
    if (b.name !== 'Sun' && b.alt > 0) out.push(b);
  }
  for (const st of lastSnapshot.visibleNamedStars) {
    if (st.alt > 0) out.push(st);
  }
  out.sort((x, y) => x.mag - y.mag);
  const seen = new Set();
  return out.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true))).slice(0, 8);
}

function setFindUi(mode) {
  state.finding = mode;
  btnFind.classList.toggle('active', mode !== 'idle');
  btnFind.textContent = mode === 'idle' ? 'Find' : 'Stop';
  hudPanel.setButtonActive('find', mode !== 'idle');
}

function enterFindChoose() {
  if (state.calStep !== 'idle') exitCalibration();
  wayfinder.setTarget(null);
  setFindUi('choose');
  const cands = getFindCandidates();
  hudPanel.setRow([
    ...cands.slice(0, 6).map((c) => ({ id: `findpick:${c.name}`, label: c.name })),
    { id: 'find', label: 'Cancel', active: true }
  ]);
  infoCardEl.innerHTML = '<h2>Find: choose a target</h2><div class="meta">Pick something above the horizon and follow the arrow:</div>';
  const list = document.createElement('div');
  list.className = 'ref-list';
  for (const c of cands) {
    const btn = document.createElement('button');
    btn.textContent = `${c.name} (alt ${c.alt.toFixed(0)}°)`;
    btn.onclick = () => handleAction(`findpick:${c.name}`);
    list.appendChild(btn);
  }
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.onclick = () => handleAction('find');
  list.appendChild(cancel);
  infoCardEl.appendChild(list);
}

function startFinding(name) {
  const t = findTargetByName(name);
  if (!t) return;
  state.findName = name;
  setFindUi('tracking');
  wayfinder.setTarget(t);
  hudPanel.setRow([{ id: 'find', label: 'Stop finding', active: true }]);
  updateHtmlInfo(`Finding ${name}`, 'Follow the arrow, drag to look around. It will lock on when you are pointing at it.');
}

/** @param {boolean} resetInfo restore the default info-card text (cancel path) */
function exitFind(resetInfo) {
  if (state.finding === 'idle') return;
  setFindUi('idle');
  state.findName = null;
  wayfinder.setTarget(null);
  hudPanel.setRow([{ id: 'resetAlign', label: 'Reset alignment' }]);
  if (resetInfo) {
    infoCardEl.innerHTML = `<h2>Look up &amp; select any star or planet</h2><div class="meta">${FIND_INFO_DEFAULT}</div>`;
  }
}

function completeFind(name) {
  const target = findTargetByName(name);
  exitFind(false);
  if (!target || !skyScene) return;
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  state.selectedTarget = target;
  skyScene.highlightTarget(target, cam.position);
  pulseStart = performance.now();
  if (state.inXR) spatialCard.show(target, state.nightMode);
  const details = [
    target.subtitle,
    `Alt ${target.alt.toFixed(1)}° • Az ${target.az.toFixed(1)}°`,
    target.extra || (target.mag !== undefined ? `Mag ${target.mag.toFixed(2)}` : '')
  ].filter(Boolean).join('<br/>');
  updateHtmlInfo(`Found ${target.name} ✓`, details);
}

function setCalUi(step) {
  state.calStep = step;
  state.calibrating = step !== 'idle';
  btnCal.classList.toggle('active', state.calibrating);
  btnCal.textContent = state.calibrating ? 'Cancel' : 'Calibrate';
  hudPanel.setButtonActive('calibrate', state.calibrating);
}

function enterChooseStep() {
  if (state.finding !== 'idle') exitFind(false);
  setCalUi('choose');
  calibrator.startCalibration();
  state.calTargetName = null;
  const cands = getReferenceCandidates();
  if (cands.length === 0) {
    hudPanel.setRow([{ id: 'calibrate', label: 'Cancel', active: true }]);
    updateHtmlInfo('Calibration', 'No bright reference object is above the horizon right now (need Moon, a bright planet, or a star of mag ≤ 1). Try again later or adjust the time with -1h / +1h.');
    return;
  }
  hudPanel.setRow([
    ...cands.map((c) => ({ id: `ref:${c.name}`, label: c.name })),
    { id: 'calibrate', label: 'Cancel', active: true }
  ]);
  infoCardEl.innerHTML = '<h2>Calibration: choose a reference</h2><div class="meta">Pick an object you can see in the real sky, then point at it:</div>';
  const list = document.createElement('div');
  list.className = 'ref-list';
  for (const c of cands) {
    const btn = document.createElement('button');
    btn.textContent = `${c.name} (alt ${c.alt.toFixed(0)}°)`;
    btn.onclick = () => handleAction(`ref:${c.name}`);
    list.appendChild(btn);
  }
  infoCardEl.appendChild(list);
}

function enterPointStep(name) {
  setCalUi('point');
  calibrator.startCalibration();
  state.calTargetName = name;
  hudPanel.setRow([{ id: 'calibrate', label: 'Cancel', active: true }]);
  const t = findTargetByName(name);
  if (t) skyScene?.highlightTarget(t, camera.position);
  updateHtmlInfo(`Point at the real ${name}`, `Point at the real ${name} and pinch/click. (Desktop: click where you see it in the sky.)`);
}

function exitCalibration() {
  const wasTap = state.calStep === 'tap';
  setCalUi('idle');
  state.calTaps = [];
  handInput.setLaser(false);
  if (wasTap && state.realSky !== state.calRealSkyWas) toggleRealSky(state.calRealSkyWas);
  calibrator.cancelCalibration();
  state.calTargetName = null;
  hudPanel.setRow([{ id: 'resetAlign', label: 'Reset alignment' }]);
}

let pulseStart = -1;
const PULSE_MS = 1400;

function finishSnap(ray) {
  const name = state.calTargetName;
  // Targets are recomputed every 15s; look the live position up by name at pinch time.
  const target = findTargetByName(name);
  if (!target) {
    exitCalibration();
    updateHtmlInfo('Calibration failed', `${name} is no longer available in the sky snapshot.`);
    return;
  }
  // Yaw only: snapToTarget compares azimuths, gravity (pitch/roll) is already known.
  const deg = calibrator.snapToTarget(target.pos, ray.direction);
  if (!state.inXR) calibrator.save(); // desktop only; XR yaw is per-session
  exitCalibration();
  state.selectedTarget = target;
  skyScene.highlightTarget(target, camera.position);
  pulseStart = performance.now();
  const msg = `Locked to ${target.name} — ${deg.toFixed(1)}° correction`;
  calHintEl.textContent = msg;
  statusEl.textContent = msg;
  updateHtmlInfo(`Locked to ${target.name}`, `${deg.toFixed(1)}° yaw correction applied. Use "Reset alignment" to undo.`);
  if (state.inXR) spatialCard.show(target, state.nightMode);
}

function updatePulse(now) {
  const ring = skyScene?.selectionRing;
  if (!ring || pulseStart < 0) return;
  const k = (now - pulseStart) / PULSE_MS;
  if (k >= 1) {
    pulseStart = -1;
    ring.scale.setScalar(1);
    ring.material.opacity = 0.9;
    return;
  }
  const wave = Math.abs(Math.sin(k * Math.PI * 3));
  ring.scale.setScalar(1 + 1.4 * (1 - k) * wave);
  ring.material.opacity = 0.35 + 0.65 * wave;
}

function updateHtmlInfo(title, body) {
  infoCardEl.innerHTML = `<h2>${title}</h2><div class="meta">${body}</div>`;
}

function handleRaySelect(raycaster) {
  if (state.inXR && hudPanel.group.visible) {
    const hudHits = raycaster.intersectObjects(hudPanel.buttonMeshes, false);
    if (hudHits.length > 0) {
      hudPanel.trigger(hudHits[0].object.userData.hudAction);
      return;
    }
  }

  if (!skyScene) return;

  // Point step: the user is aiming at the REAL object, so never raycast virtual sky objects.
  if (state.calStep === 'point') {
    finishSnap(raycaster.ray);
    return;
  }
  if (state.calStep === 'tap') { calTap(raycaster.ray.direction); return; }

  if (state.realSky) { realSkyTap(raycaster.ray); return; }

  // Planets/Moon/Sun first (real meshes); otherwise the nearest of ALL catalogue stars by angle.
  const hits = raycaster.intersectObjects(skyScene.planetGroup.children, false);
  let target = hits.length > 0 ? hits[0].object.userData.target : null;
  const cam = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
  if (!target && state.showSatellites && satellites) target = satellites.pick(raycaster.ray.direction, cam.fov || 65);
  if (!target) {
    target = skyScene.pickStar(raycaster.ray.direction, cam.fov || 65);
  }
  if (target) selectTarget(target);
}

// ---- Simulated passthrough (demo footage only): a real all-sky photo stands in for the passthrough camera ----
let skyPhoto = null;
async function simPassthrough(on) {
  if (on && !skyPhoto) { skyPhoto = new SkyPhoto(skyScene.skyRoot); await skyPhoto.load(); }
  skyPhoto?.setVisible(on);
  skyScene.domeSky.setVisible(!on);
  if (on) skyPhoto.update(displayDate(), skyScene.lat, skyScene.lon, 0);
}

// ---- Real-sky mode: only the real sky is drawn; taps are forgiving and teach the alignment ----
const REAL_TAP_DEG = 3.5;      // the real object can be ~1 deg off ours, plus an unsteady hand
const REAL_STAR_MAG_CAP = 2.5; // only stars bright enough to actually be seen through passthrough

function toggleRealSky(on = !state.realSky) {
  state.realSky = on;
  skyScene?.setRealSky(on);
  magDial.setRealSky(on);
  document.body.classList.toggle('real-sky', on);
  updateHtmlInfo(on ? 'Real sky' : 'Sky overlay',
    on ? 'Drawings hidden. Point at the real Moon, a planet or a bright star and tap it: it is named, and each tap fine-tunes the alignment.'
       : 'Stars, lines and labels are back.');
}

function realSkyTap(ray) {
  const dir = ray.direction;
  // brightest-first: the Moon/planets, then sunlit satellites, then the bright stars; each in a wide cone
  let target = skyScene.pickBody(dir, REAL_TAP_DEG);
  if (!target && state.showSatellites && satellites) target = satellites.pick(dir, 65, { maxDeg: 2.5, sunlitOnly: true });
  if (!target) target = skyScene.pickStar(dir, 65, { maxDeg: REAL_TAP_DEG, magCap: REAL_STAR_MAG_CAP, magWeight: 0.35 });
  if (!target) return;
  selectTarget(target);
  learnFromTap(target, dir);
}

/** Our computed direction of a target, in skyRoot-local space (stars live in the celestial group). */
function skyLocalDir(target) {
  const s = new THREE.Vector3(target.pos.x, target.pos.y, target.pos.z);
  if (target.kind === 'star') s.applyQuaternion(skyScene.celestialGroup.quaternion);
  return s.normalize();
}

/** Point the sky along a fitted rotation (yaw goes to the calibrator, the small rest to the trim). */
function applyFit(qFit) {
  const q = new THREE.Quaternion(qFit.x, qFit.y, qFit.z, qFit.w);
  const yaw = yawOf(qFit);
  calibrator.targetYaw = yaw; // (direct: not snapToTarget, which would reset the refinement)
  trimTarget.setFromAxisAngle(_Y, -yaw).multiply(q);
}

// ---- Guided calibration: point your finger at two real objects (the Moon + a bright star, or two bright stars).
// Gravity gives each pointing direction's height; the angle between the two taps ignores the compass; together they
// say WHICH objects you pointed at (twoPoint.js), and the pair pins the whole sky. A doubtful pair asks for a third.
let morphUntil = 0;       // after a lock, the drawings glide slowly onto the real sky so you see them land
const MORPH_MS = 1800;

function calCandidates() {
  if (!lastSnapshot) return [];
  const out = [];
  for (const b of lastSnapshot.solarSystem) {
    if (b.name === 'Sun' || b.alt <= 3) continue;
    if (b.name === 'Moon' || b.mag < 2) out.push({ name: b.name, s: skyLocalDir(b), mag: b.mag, weight: 2, target: b });
  }
  for (const st of lastSnapshot.visibleNamedStars) {
    if (st.alt > 3 && st.mag <= 2.2) out.push({ name: st.name, s: skyLocalDir(st), mag: st.mag, weight: 1, target: st });
  }
  return out;
}

function calPrompt(title, body) {
  updateHtmlInfo(title, body);
  statusEl.textContent = title;
  calHintEl.textContent = title;
}

function enterTapCalibration() {
  if (state.finding !== 'idle') exitFind(false);
  setCalUi('tap');
  state.calTaps = [];
  calibrator.startCalibration();
  hudPanel.setRow([{ id: 'calibrate', label: 'Cancel', active: true }]);
  handInput.setLaser(true);
  // only the real sky while you point: our (still misaligned) drawings would just confuse the eye
  state.calRealSkyWas = state.realSky;
  if (state.isAR && !state.realSky) toggleRealSky(true);
  const moonUp = calCandidates().some((c) => c.name === 'Moon');
  calPrompt(moonUp ? 'Point at the Moon and pinch' : 'Point at the brightest star you can see and pinch',
    'Aim your finger at the real object in the sky (the line from your hand shows where). Desktop: click where it is.');
}

function calTap(dirWorld) {
  state.calTaps.push(dirWorld.clone().normalize());
  handInput.pulse(0.6, 40, handInput.controllers[0]); handInput.pulse(0.6, 40, handInput.controllers[1]);
  if (state.calTaps.length === 1) {
    calPrompt('Now another bright star, and pinch', 'Pick one a few hand-widths away from the first. The brighter, the better.');
    return;
  }
  const res = identifyTaps(state.calTaps, calCandidates());
  if (!res.ok) {
    if (res.reason === 'too-close') {
      state.calTaps.pop();
      calPrompt('Pick one further away, and pinch', 'Those two are too close together to line the sky up. Choose a star a few hand-widths away.');
    } else {
      state.calTaps = [];
      calPrompt('Couldn\'t match those, try again', 'Point at the Moon or the brightest star first, then a second bright star. Hold your hand steady as you pinch.');
    }
    return;
  }
  if (res.ambiguous && state.calTaps.length < 3) {
    calPrompt('One more bright star, and pinch', 'Those two could be more than one pair of stars. A third settles it.');
    return;
  }
  // lock: the matched pairs become the start of the real-sky refinement, so later taps keep improving it
  refine.reset();
  let r = null;
  for (const m of res.matches) r = refine.add(m.cand.s, state.calTaps[m.tap], m.cand.weight ?? 1);
  applyFit(r ? r.q : res.q);
  morphUntil = performance.now() + MORPH_MS;
  const names = res.matches.map((m) => m.cand.name);
  const last = res.matches[res.matches.length - 1].cand.target;
  exitCalibration();
  const msg = `Locked on ${names.join(' + ')} (±${(r ? r.rmsDeg : res.rmsDeg).toFixed(1)}°)`;
  calHintEl.textContent = msg;
  statusEl.textContent = msg;
  updateHtmlInfo(msg, 'The sky is lined up. In real-sky mode every object you tap keeps fine-tuning it.');
  if (last) { state.selectedTarget = last; skyScene.highlightTarget(last, camera.position); pulseStart = performance.now(); }
  if (state.inXR && last) spatialCard.show(last, state.nightMode);
}

/** One observation: our direction of `target` (skyRoot-local) vs where the hand pointed (world). */
function learnFromTap(target, dirWorld) {
  // only for real pointing in the headset, at the live sky (a scrubbed sky is not the real one), never satellites
  if (!state.inXR || target.kind === 'satellite') return;
  if (Math.abs(state.timeOffsetHours) > 0.01 || dialState?.scrubbing) return;
  const s = new THREE.Vector3(target.pos.x, target.pos.y, target.pos.z);
  if (target.kind === 'star') s.applyQuaternion(skyScene.celestialGroup.quaternion); // celestial -> skyRoot local
  s.normalize();
  const w = dirWorld.clone().normalize();
  const weight = target.kind === 'planet' ? 2 : 1; // Moon/planets are big and unmistakable
  const r = refine.add(s, w, weight);
  applyFit(r.q);
  const msg = r.rejected
    ? `${target.name}: that tap disagreed with the others, ignored`
    : `Aligned on ${refine.count} point${refine.count > 1 ? 's' : ''} (±${r.rmsDeg.toFixed(1)}°)`;
  calHintEl.textContent = msg;
  statusEl.textContent = msg;
}

function clearSatSelection() {
  satellites?.setSelected(null);
  state.selectedTarget = null;
  skyScene?.highlightTarget(null);
}

function selectTarget(target) {
  state.selectedTarget = target;
  satellites?.setSelected(target);
  skyScene.highlightTarget(target, camera.position);
  if (target.kind === 'satellite') skyScene.skyRoot.add(skyScene.selectionRing); // satellites live in skyRoot space
  if (state.inXR) {
    spatialCard.show(target, state.nightMode);
  }
  if (target.kind === 'satellite') {
    if (state.calStep === 'idle') showSatInfo(target);
  } else if (state.calStep === 'idle') {
    const details = [
      target.subtitle,
      `Alt ${target.alt.toFixed(1)}° • Az ${target.az.toFixed(1)}°`,
      target.extra || (target.mag !== undefined ? `Mag ${target.mag.toFixed(2)}` : '')
    ].filter(Boolean).join('<br/>');
    updateHtmlInfo(target.name, details);
  }
}

const handInput = new XRInputManager(renderer, scene, handleRaySelect, {
  // Scrubbing is armed only when the press starts on empty sky (not on the HUD, not while calibrating/finding).
  canScrub: (raycaster) => {
    if (state.calStep !== 'idle' || state.finding !== 'idle') return false;
    if (hudPanel.group.visible) {
      if (raycaster.intersectObjects(hudPanel.buttonMeshes, false).length > 0) return false;
      if (raycaster.intersectObject(hudPanel.bg, false).length > 0) return false;
    }
    return true;
  },
  onScrubBegin: () => dial.begin(),
  onScrubTurn: (deg) => dial.turn(deg, { gain: GAIN_XR }),
  onScrubEnd: () => dial.end(),
  onMagBegin: () => { magTwisting = true; },
  onMagTurn: (d) => { magCtl.turn(d); applyMag(true); },
  onMagEnd: () => { magTwisting = false; },
  onMagTap: () => toggleRealSky()
});

// Desktop mouse-look & click selection
let isDragging = false;
let moved = false;
let prevX = 0;
let prevY = 0;
let yaw = 0;
let pitch = 0.45; // Start looking up at ~25° altitude

function applyDesktopCamera() {
  if (state.inXR) return;
  const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch);
  camera.quaternion.copy(qYaw).multiply(qPitch);
}
applyDesktopCamera();

renderer.domElement.addEventListener('pointerdown', (e) => {
  isDragging = true;
  moved = false;
  prevX = e.clientX;
  prevY = e.clientY;
});
window.addEventListener('pointermove', (e) => {
  if (!isDragging || state.inXR) return;
  const dx = e.clientX - prevX;
  const dy = e.clientY - prevY;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
  prevX = e.clientX;
  prevY = e.clientY;
  yaw += dx * 0.004;
  pitch = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, pitch + dy * 0.004));
  applyDesktopCamera();
});
window.addEventListener('pointerup', (e) => {
  if (!isDragging) return;
  isDragging = false;
  if (!moved && !state.inXR) {
    const ndc = new THREE.Vector2(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    handleRaySelect(raycaster);
  }
});

// UI Button bindings
btnCal.onclick = () => handleAction('calibrate');
btnFind.onclick = () => handleAction('find');
btnResetAlign.onclick = () => handleAction('resetAlign');
// Desktop keyboard: [ and ] turn the dial -/+15 deg, backslash returns to live. (Arrow keys are the DesktopDial's own.)
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === '\\') { dialGoLive(); return; }
  if (e.key === 'r' || e.key === 'R') { toggleRealSky(); return; }
  const dir = e.key === ']' ? 1 : e.key === '[' ? -1 : 0;
  if (!dir) return;
  e.preventDefault();
  if (!dialState.scrubbing || dialState.coasting) dial.begin({ coast: false });
  dial.turn(dir * 15);
  clearTimeout(keyTurnTimer);
  keyTurnTimer = setTimeout(() => dial.end(), 250);
});
btnLines.onclick = () => handleAction('constellations');
btnNight.onclick = () => handleAction('night');
btnSats.onclick = () => handleAction('satellites');

// ---- [Engineer D] Push-to-align: both palms pushed at a bright object re-solves yaw (see src/xr/pushAlign.js) ----
const pushAlign = new PushAlign({
  renderer, scene, calibrator,
  getCandidates: getReferenceCandidates,
  isBusy: () => state.calStep !== 'idle' || state.finding !== 'idle' || dialState.scrubbing || previewActive || !dialState.isLive || spatialCard.mesh.visible || state.realSky,
  isXR: () => state.inXR,
  haptic: () => { handInput.pulse(1, 60, handInput.controllers[0]); handInput.pulse(1, 60, handInput.controllers[1]); },
  onMessage: (text) => { statusEl.textContent = text; },
  onAligned: (target, deg) => { // same confirmation as finishSnap
    if (!state.inXR) calibrator.save();
    state.selectedTarget = target;
    skyScene.highlightTarget(target, camera.position);
    pulseStart = performance.now();
    const msg = `Locked to ${target.name} — ${deg.toFixed(1)}° correction`;
    calHintEl.textContent = msg;
    statusEl.textContent = msg;
    updateHtmlInfo(`Locked to ${target.name}`, `${deg.toFixed(1)}° yaw correction applied (push gesture). Use "Reset alignment" to undo.`);
    if (state.inXR) spatialCard.show(target, state.nightMode);
  }
});

// WebXR Session launchers
async function startXR(mode) {
  const sessionInit = {
    optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']
  };
  const session = await navigator.xr.requestSession(mode, sessionInit);
  state.inXR = true;
  // XR reference-space yaw differs between sessions, so a saved desktop offset would be wrong here.
  calibrator.reset(true);
  pushAlign.startSession(); // [Engineer D]
  exitCalibration();
  exitFind(false);
  state.isAR = mode === 'immersive-ar';
  skyScene?.setARMode(state.isAR);
  hudPanel.group.visible = true;
  // in mixed reality the real sky is right there: start by lining ours up with it (two pinches; Cancel skips)
  if (state.isAR) enterTapCalibration();

  session.addEventListener('select', (e) => {
    if (!e.inputSource || e.inputSource.targetRayMode !== 'screen') return;
    const refSpace = renderer.xr.getReferenceSpace();
    const pose = refSpace && e.frame ? e.frame.getPose(e.inputSource.targetRaySpace, refSpace) : null;
    if (!pose) return;
    const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
    const origin = new THREE.Vector3().setFromMatrixPosition(m);
    const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(new THREE.Matrix4().extractRotation(m)).normalize();
    handleRaySelect(new THREE.Raycaster(origin, dir));
  });

  session.addEventListener('end', () => {
    state.inXR = false;
    state.isAR = false;
    exitCalibration();
    exitFind(false);
    calibrator.loadSaved(); // back on desktop: restore the persisted desktop alignment
    skyScene?.setARMode(false);
    hudPanel.group.visible = false;
    spatialCard.hide();
    applyDesktopCamera();
  });

  await renderer.xr.setSession(session);
}

function checkXRSupport() {
  if ('xr' in navigator) {
    navigator.xr.isSessionSupported('immersive-ar').then((ok) => {
      btnAr.disabled = !ok;
      if (ok) btnAr.onclick = () => startXR('immersive-ar');
    });
    navigator.xr.isSessionSupported('immersive-vr').then((ok) => {
      btnVr.disabled = !ok;
      if (ok) btnVr.onclick = () => startXR('immersive-vr');
    });
  }
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Boot
async function boot() {
  const sim = await initSimulatorIfRequested();
  checkXRSupport();

  catalog = await loadSkyCatalog();
  skyScene = new SkyScene(scene, catalog);
  skyScene.enableAtmosphere(renderer); // physical sky; async, falls back to the gradient
  hudPanel.setButtonActive('constellations', true);
  refreshSky();
  bootSatellites();

  if (sim?.isDemo) {
    runAutomatedVrDemo({ renderer, scene, skyScene, hudPanel, findTargetByName, startXR, state });
  }

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.lat = pos.coords.latitude;
        state.lon = pos.coords.longitude;
        state.locationLabel = `${state.lat.toFixed(2)}°, ${state.lon.toFixed(2)}°`;
        dial.setLocation(state.lat, state.lon);
        refreshSky();
      },
      () => {} // Keep default location silently
    );
  }

  setInterval(() => { if (!dial.state.scrubbing) refreshSky(); }, 15000); // never reset the sky mid-scrub
}

boot();
if (import.meta.env.DEV) window.__xw = { get skyScene() { return skyScene; }, get satellites() { return satellites; }, camera, dial, calibrator, state, get snapshot() { return lastSnapshot; },
  /** dev/demo capture hooks */
  simPassthrough(on = true) { return simPassthrough(on); },
  startXR(mode = 'immersive-vr') { return startXR(mode); },
  selectByName(n) { const t = findTargetByName(n); if (t) selectTarget(t); return !!t; },
  action(a) { handleAction(a); },
  toggleRealSky(on) { toggleRealSky(on); },
  look(azDeg, altDeg) { yaw = -azDeg * Math.PI / 180; pitch = altDeg * Math.PI / 180; applyDesktopCamera(); },
  /** dev: the alignment the sky is easing toward (yaw x trim) */
  get alignTarget() { return new THREE.Quaternion().setFromAxisAngle(_Y, calibrator.targetYaw).multiply(trimTarget); },
  /** dev: a real-sky tap along a world direction (set state.inXR to exercise the alignment learning) */
  realSkyTap(d) { realSkyTap({ direction: new THREE.Vector3(d.x, d.y, d.z).normalize() }); },
  startTapCalibration() { enterTapCalibration(); },
  calTap(d) { calTap(new THREE.Vector3(d.x, d.y, d.z)); },
  get calStep() { return state.calStep; },
  calCandidates() { return calCandidates().map((c) => ({ name: c.name, mag: c.mag, s: { x: c.s.x, y: c.s.y, z: c.s.z } })); },
  /** dev: aim the desktop camera at a world direction */
  lookAt(v) { yaw = Math.atan2(-v.x, -v.z); pitch = Math.asin(Math.max(-1, Math.min(1, v.y / Math.hypot(v.x, v.y, v.z)))); applyDesktopCamera(); } };
if (import.meta.env.DEV) window.__xw.simulatePush = (altDeg, azWorldDeg = 0) => pushAlign.simulatePush(altDeg, azWorldDeg); // [Engineer D]

let lastTime = performance.now();
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;

  dial.tick(dt);
  handInput.update(dt);
  if (state.inXR) pushAlign.update(dt, renderer.xr.getCamera()); // [Engineer D]

  if (skyScene) {
    const morphRate = now < morphUntil ? 2.2 : 8; // slow glide right after a lock, so you see the sky land
    _yawQ.setFromAxisAngle(_Y, calibrator.update(dt * morphRate / 8));
    trimQ.slerp(trimTarget, Math.min(1, dt * morphRate));
    skyScene.skyRoot.quaternion.copy(_yawQ).multiply(trimQ);
    skyScene.tick(dt, renderer.xr.isPresenting ? renderer.xr.getCamera() : camera);
    if (skyPhoto?.mesh.visible) skyPhoto.update(displayDate(), skyScene.lat, skyScene.lon, dt);
    updateSatellites();
    const selSat = state.selectedTarget?.kind === 'satellite' ? state.selectedTarget : null;
    if (selSat) {
      const ring = skyScene.selectionRing;
      ring.position.set(selSat.pos.x, selSat.pos.y, selSat.pos.z);
      ring.lookAt(renderer.xr.isPresenting ? renderer.xr.getCamera().position : camera.position);
      ring.visible = selSat.alt > 0 && state.showSatellites;
    }
    aimReticle.update(now, camera, skyScene, state.selectedTarget, {
      visible: !renderer.xr.isPresenting,
      pickExtra: state.showSatellites && satellites ? (d, fov) => satellites.pick(d, fov) : null
    });
    updatePulse(now);
    if (state.finding === 'tracking') {
      // Positions are recomputed every 15s; re-resolve the target by name each frame.
      wayfinder.setTarget(findTargetByName(state.findName));
      wayfinder.update(dt, renderer.xr.isPresenting ? renderer.xr.getCamera() : camera, skyScene.skyRoot, state.nightMode);
    }
  }

  if (state.inXR) {
    const xrCam = renderer.xr.getCamera();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCam.quaternion);
    const flatForward = new THREE.Vector3(forward.x, 0, forward.z).normalize();
    if (flatForward.lengthSq() > 0.01) {
      hudPanel.group.position.copy(xrCam.position).addScaledVector(flatForward, 1.35);
      hudPanel.group.position.y -= 0.42;
      hudPanel.group.lookAt(xrCam.position);

      if (spatialCard.mesh.visible) {
        // the card sits BESIDE the selected object (world-anchored), not in the middle of the view, and fades out
        const t = state.selectedTarget;
        const age = (performance.now() - (spatialCard.shownAt ?? 0)) / 1000;
        if (!t || !t.pos || age > CARD_SECONDS) spatialCard.hide();
        else {
          const p = _cardV.set(t.pos.x, t.pos.y, t.pos.z);
          (t.kind === 'star' ? skyScene.celestialGroup : skyScene.skyRoot).localToWorld(p);
          const dir = p.sub(xrCam.position).normalize();
          const right = _cardR.crossVectors(dir, _Y).normalize();
          spatialCard.mesh.position.copy(xrCam.position).addScaledVector(dir, 2.4).addScaledVector(right, 0.5).addScaledVector(_Y, -0.1);
          spatialCard.mesh.lookAt(xrCam.position);
          spatialCard.mesh.scale.setScalar(0.85);
        }
      }
    }
  }

  // Agamotto ring follows the scrubbing hand, ~5 cm along its ray, turned to face the user.
  const scrubCtrl = handInput.scrubController;
  const ringVisible = state.inXR && dialState.scrubbing; // includes coasting; the ring lingers itself
  if (ringVisible && scrubCtrl) {
    scrubCtrl.getWorldPosition(ringPos);
    scrubCtrl.getWorldDirection(ringDir); // +Z of the controller (points back toward the user)
    ringPos.addScaledVector(ringDir, -0.05);
    renderer.xr.getCamera().getWorldPosition(ringCamPos);
    ringAim.position.copy(ringPos);
    ringAim.lookAt(ringCamPos);
  }
  agamottoRing.update(dt, {
    visible: ringVisible,
    position: ringAim.position,
    quaternion: ringAim.quaternion,
    state: dialState,
    nightMode: state.nightMode
  });

  // Left-hand star-depth ring
  updateAutoMag(now);
  const magCtrl = handInput.magController;
  const magVisible = state.inXR && magTwisting && !!magCtrl;
  if (magVisible) {
    magCtrl.getWorldPosition(ringPos);
    magCtrl.getWorldDirection(ringDir);
    ringPos.addScaledVector(ringDir, -0.05);
    renderer.xr.getCamera().getWorldPosition(ringCamPos);
    magAim.position.copy(ringPos);
    magAim.lookAt(ringCamPos);
  }
  magRing.update(dt, { visible: magVisible, position: magAim.position, quaternion: magAim.quaternion,
    state: magRingState(), nightMode: state.nightMode });

  renderer.render(scene, camera);
});
window.addEventListener('pagehide', () => wayfinder.dispose());
