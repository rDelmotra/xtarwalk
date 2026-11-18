import * as THREE from 'three';
import { SKY_RADIUS, altAzToVec3, computeSolarSystem, describeStarColour, starDisplayName } from '../astro/skyEngine.js';
import { makeTextSprite } from './labels.js';
import { DomeSky } from './domeSky.js';
import { Atmosphere } from './atmosphere.js';
import { Compass } from './compass.js';
import { StarField } from './starField.js';
import { StarTrails } from './starTrails.js';
import { ConstellationLines } from './constellationLines.js';
import { Moon } from './moon.js';

const DEG2RAD = Math.PI / 180;
/** Sidereal rate: 360.98565 deg per solar day. */
const SIDEREAL_DEG_PER_HOUR = 15.04107;
const BODY_PREVIEW_MIN_MS = 1000 / 15;
const CONST_LABEL_MIN_Y = SKY_RADIUS * Math.sin(5 * DEG2RAD); // constellation labels need alt > 5 deg
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Star/line day fade from sun altitude (deg): fully faded above 0, fully visible below -6. */
function dayFadeForSunAlt(alt) {
  const t = Math.min(1, Math.max(0, (alt + 6) / 6));
  return 1 - t * t * (3 - 2 * t);
}
/** In daylight stars, lines and satellites never vanish completely: a faint floor says "they are there". */
export const DAY_FLOOR = 0.15;
const withDayFloor = (fade) => DAY_FLOOR + (1 - DAY_FLOOR) * fade;

export class SkyScene {
  constructor(scene, catalog) {
    this.scene = scene;
    this.catalog = catalog;
    this.skyRoot = new THREE.Group();
    this.scene.add(this.skyRoot);

    // Everything that is fixed on the celestial sphere (stars, lines, star/constellation labels and
    // hit targets) lives here so a time-scrub can rotate it rigidly about the celestial pole.
    // The compass, dome and Sun/Moon/planets are deliberately NOT inside it.
    this.celestialGroup = new THREE.Group();
    this.skyRoot.add(this.celestialGroup);
    this.starHitGroup = new THREE.Group();
    this.celestialLabelGroup = new THREE.Group();
    this.celestialGroup.add(this.starHitGroup, this.celestialLabelGroup);

    this.clickableMeshes = [];
    this.planetMeshes = new Map();
    this.labelGroup = new THREE.Group(); // body (Sun/Moon/planet) labels
    this.skyRoot.add(this.labelGroup);

    this.lat = 0;
    this.lon = 0;
    this._pole = new THREE.Vector3(0, 0, -1);
    this._rowY = new THREE.Vector3(0, 1, 0); // world-up row of celestialGroup's rotation matrix
    this._celInv = new THREE.Quaternion();
    this._snapshotDate = null;
    this._previewActive = false;
    this._lastBodyMs = -Infinity;
    this._starEntries = [];
    this._constLabelEntries = [];
    this._bodyEntries = [];
    this._bodyByName = new Map();
    this._selected = null;
    this._ringDirty = false;

    this.clipHorizon = true;
    this._lastSnapshot = null;
    this._lastShowConst = true;
    this._focusIdx = -1;
    this._focusName = null;
    this._labelSprites = [];
    this._gaze = new THREE.Vector3();
    this._invQuat = new THREE.Quaternion();
    this._buildStars();
    this._buildConstellations();
    this._buildPlanets();
    this.isAR = false;
    this.nightMode = false;
    this._hitGeo = new THREE.SphereGeometry(2.6, 12, 12);
    this._hitMat = new THREE.MeshBasicMaterial({ visible: false });
    this.domeSky = new DomeSky(scene);
    this.compass = new Compass(this.skyRoot);
    this._skyQuat = new THREE.Quaternion();
    this._camPos = new THREE.Vector3();
    this._buildSelectionRing();
    this.setARMode(false);
  }

  _buildStars() {
    this.starField = new StarField(this.catalog.stars);
    this.starPoints = this.starField.points;
    this.starMaterial = this.starField.material;
    this.celestialGroup.add(this.starPoints);
    // Trails are a child of skyRoot (not celestialGroup): their shader rotates by absolute angles.
    this.starTrails = new StarTrails(this.catalog.stars);
    this.skyRoot.add(this.starTrails.object);
  }

  _buildConstellations() {
    this.constLines = new ConstellationLines(this.catalog, this.celestialGroup);
    this._constNames = this.constLines.names;
    this._constIdx = this.constLines.idx;
    this._weights = this.constLines.weights;
    this.lineMaterial = this.constLines.material;
    this.constellationLines = this.constLines.mesh;
  }

  _buildPlanets() {
    this.moon = new Moon(1.0);
    this._pickQ = new THREE.Quaternion();
    this._pickV = new THREE.Vector3();
    this._pickV2 = new THREE.Vector3();
    this._sunLocal = new THREE.Vector3(0, 1, 0);
    this._sunWorld = new THREE.Vector3();
    this.planetGroup = new THREE.Group();
    this.skyRoot.add(this.planetGroup);
  }

  _buildSelectionRing() {
    // Selection reticle: a faded, slowly rotating crosshair in the UI's instrument style (hairline ice ring
    // broken into 4 arcs, with 4 inward ticks in the gaps). Kept as `selectionRing` (main.js pulses its
    // scale + material.opacity), so opacity is mirrored into the shader each draw.
    const geo = new THREE.PlaneGeometry(5.2, 5.2);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uAngle: { value: 0 }, uOpacity: { value: 0.9 }, uColor: { value: new THREE.Color(0x8fe3f5) } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform float uAngle;
        uniform float uOpacity;
        uniform vec3 uColor;
        varying vec2 vUv;
        void main() {
          vec2 p = (vUv - 0.5) * 2.0;
          float r = length(p);
          float a = atan(p.y, p.x) + uAngle;
          float px = fwidth(r) * 1.2;
          // ring with four gaps (gaps centred on the rotating cardinal directions)
          float seg = abs(fract(a / 1.5707963) - 0.5) * 2.0;          // 0 at a gap centre, 1 mid-arc
          float arcs = smoothstep(0.22, 0.30, seg);
          float ring = (1.0 - smoothstep(0.0, px, abs(r - 0.62))) * arcs;
          // inward ticks inside the gaps
          float ang = abs(fract(a / 1.5707963 + 0.5) - 0.5) * 1.5707963;  // angular distance to the nearest gap centre
          float tick = (1.0 - smoothstep(0.0, px, ang * r - 0.0)) * step(0.70, r) * step(r, 0.92);
          float inner = (1.0 - smoothstep(0.0, px, abs(r - 0.40))) * 0.35 * arcs; // faint inner hairline
          float glow = exp(-abs(r - 0.62) * 18.0) * 0.18 * arcs;
          float v = max(max(ring, tick), inner) + glow;
          if (v < 0.003) discard;
          gl_FragColor = vec4(uColor, v * uOpacity * 0.62);
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      opacity: 0.9
    });
    this.selectionRing = new THREE.Mesh(geo, mat);
    this.selectionRing.onBeforeRender = () => { mat.uniforms.uOpacity.value = mat.opacity; };
    this.selectionRing.visible = false;
    this.selectionRing.renderOrder = 15;
    this.skyRoot.add(this.selectionRing);
  }

  /** Observer location (sets the celestial pole axis used by setScrubPreview). */
  setObserver(lat, lon) {
    this.lat = lat;
    this.lon = lon;
    // North celestial pole direction in the local frame (+Y up, -Z north). Also right for lat < 0.
    const p = altAzToVec3(lat, 0, 1);
    this._pole.set(p.x, p.y, p.z).normalize();
    this.starTrails?.setPole(this._pole);
  }

  _setCelestialRotation(angleRad) {
    const q = this.celestialGroup.quaternion;
    if (angleRad === 0) q.set(0, 0, 0, 1);
    else q.setFromAxisAngle(this._pole, angleRad);
    this._celInv.copy(q).invert();
    this._rowY.set(2 * (q.x * q.y + q.w * q.z), 1 - 2 * (q.x * q.x + q.z * q.z), 2 * (q.y * q.z - q.w * q.x));
  }

  /**
   * Fast time-scrub preview. Rotates the fixed-star sky rigidly about the celestial pole, recomputes
   * Sun/Moon/planets exactly for `date` (throttled to 15 Hz, existing meshes are moved, nothing is
   * rebuilt) and updates dome sun + star day-fade. Safe to call every frame.
   *
   * deltaHours = shown time - time of the last updateSnapshot(). If the last snapshot carries its own
   * `date` (computeSkySnapshot does) the delta is derived from `date` instead, so a caller that is
   * off by one refresh cannot double-apply rotation.
   */
  setScrubPreview(deltaHours, date) {
    if (this._snapshotDate && date) deltaHours = (date.getTime() - this._snapshotDate.getTime()) / 3.6e6;
    this._previewActive = true;
    // Stars rise in the east / set in the west: that is a NEGATIVE turn about +pole for forward time.
    this._setCelestialRotation(-deltaHours * SIDEREAL_DEG_PER_HOUR * DEG2RAD);
    const t = nowMs();
    if (date && t - this._lastBodyMs >= BODY_PREVIEW_MIN_MS) {
      this._lastBodyMs = t;
      this._updateBodies(date);
      this._applyCelestialVisibility();
    }
    if (date) this.starTrails.feed(date.getTime(), date.getTime() - deltaHours * 3.6e6);
  }

  /**
   * Back to the exact (unrotated) snapshot. Expected order from the caller:
   *   updateSnapshot(newSnapshot);  clearScrubPreview();
   * (updateSnapshot itself already resets the rotation, so either order is safe within one task.)
   */
  clearScrubPreview() {
    this._previewActive = false;
    this._lastBodyMs = -Infinity;
    this._setCelestialRotation(0);
    this._applyCelestialVisibility();
  }

  _applySun(alt, az) {
    const sv = altAzToVec3(alt, az, 1);
    this._sunLocal.set(sv.x, sv.y, sv.z);
    this._dayFadeNow = dayFadeForSunAlt(alt);
    this.sunAlt = alt;
    this.domeSky.setSun(sv);
    const fade = dayFadeForSunAlt(alt);
    const shown = withDayFloor(fade);
    this.starField.setDayFade(shown);
    this.starTrails.setDayFade(shown);
    this.lineMaterial.uniforms.uDayFade.value = shown;
    this.dayVisibility = shown; // read by other overlays (satellites)
    // Labels fade with the stars, so their dark boxes don't sit on a daytime sky.
    if (Math.abs(fade - (this._dayFade ?? 1)) > 0.01) {
      this._dayFade = fade;
      for (const lbl of this._labelSprites) {
        if (lbl.userData.constIdx !== undefined) {
          lbl.userData.lastW = -1;
          this._applyLabelWeight(lbl, lbl.userData.w ?? 0);
        } else {
          lbl.material.opacity = fade;
        }
      }
    }
  }

  _updateBodies(date) {
    const fresh = computeSolarSystem(date, this.lat, this.lon);
    for (const f of fresh) {
      const e = this._bodyByName.get(f.name);
      if (!e) continue;
      Object.assign(e.target, f); // keep target identity (selection / info card hold it)
      const p = f.pos;
      e.mesh.position.set(p.x, p.y, p.z);
      if (f.name === 'Moon') this.moon.orient(e.mesh);
      e.hit.position.set(p.x, p.y, p.z);
      e.label.position.set(p.x, p.y + 2.4, p.z);
      if (f.name === 'Sun') this._applySun(f.alt, f.az);
      if (this._selected === e.target) {
        this.selectionRing.position.set(p.x, p.y, p.z);
        this._ringDirty = true;
      }
    }
  }

  _setHitEnabled(hit, on) {
    if (on) hit.layers.set(0);
    else hit.layers.set(1); // raycaster tests layer 0 only; Raycaster ignores .visible
  }

  /** Show/hide per-item things whose horizon state depends on the current celestial rotation. */
  _applyCelestialVisibility() {
    const clip = this.clipHorizon;
    const ry = this._rowY;
    for (const e of this._starEntries) {
      const p = e.target.pos;
      const up = !clip || ry.x * p.x + ry.y * p.y + ry.z * p.z >= 0;
      this._setHitEnabled(e.hit, up);
      if (e.label) e.label.visible = up;
    }
    for (const e of this._constLabelEntries) {
      const p = e.target.pos;
      e.sprite.visible = ry.x * p.x + ry.y * p.y + ry.z * p.z > CONST_LABEL_MIN_Y;
    }
    for (const e of this._bodyEntries) {
      const t = e.target;
      const up = !clip || t.alt >= 0;
      // with the physical sky the Sun is drawn by the atmosphere (true disc + glare); keep only its hit target
      const skyDrawsSun = t.name === 'Sun' && this.domeSky.atmosphere && !this.isAR;
      e.mesh.visible = up && !skyDrawsSun;
      this._setHitEnabled(e.hit, up);
      e.label.visible = up && t.alt > -5;
    }
  }

  /**
   * Full rebuild at the snapshot's time. Positions are exact, so the preview rotation is reset.
   */
  updateSnapshot(snapshot, showConstellations = true) {
    this._lastSnapshot = snapshot;
    this._lastShowConst = showConstellations;
    if (Number.isFinite(snapshot.lat) && Number.isFinite(snapshot.lon)) this.setObserver(snapshot.lat, snapshot.lon);
    this._snapshotDate = snapshot.date || null;
    this._previewActive = false;
    this._lastBodyMs = -Infinity;
    this._setCelestialRotation(0);
    const clip = this.clipHorizon;
    // Update stars
    this.starField.setPositions(snapshot.starPositions);
    this.starTrails.setSnapshot(snapshot.starPositions, snapshot.date ? snapshot.date.getTime() : NaN);

    // Update constellation lines
    this.constLines.setPositions(snapshot.linePositions);
    this.constellationLines.visible = showConstellations;

    // Sun: drives dome glow + star daylight fade
    const sun = snapshot.solarSystem.find((b) => b.name === 'Sun');
    if (sun) this._applySun(sun.alt, sun.az);

    // Rebuild clickable targets & labels cleanly (disposing the old GPU resources)
    this.clickableMeshes = [];
    this._starEntries.length = 0;
    this._constLabelEntries.length = 0;
    this._bodyEntries.length = 0;
    this._bodyByName.clear();
    this._clearGroup(this.planetGroup);
    this._clearGroup(this.labelGroup);
    this._clearGroup(this.starHitGroup);
    this._clearGroup(this.celestialLabelGroup);
    this._labelSprites.length = 0;

    const hitGeo = this._hitGeo;
    const hitMat = this._hitMat;

    // Solar system bodies: always built, shown/hidden by horizon state (so a scrub can reveal them)
    for (const body of snapshot.solarSystem) {
      let mesh;
      if (body.name === 'Moon') {
        mesh = this.moon.makeMesh();
      } else {
        const geo = new THREE.SphereGeometry(body.size, 20, 20);
        const mat = new THREE.MeshBasicMaterial({ color: body.color });
        mesh = new THREE.Mesh(geo, mat);
      }
      mesh.position.set(body.pos.x, body.pos.y, body.pos.z);
      if (body.name === 'Moon') this.moon.orient(mesh);
      mesh.userData.target = body;
      this.planetGroup.add(mesh);
      this.clickableMeshes.push(mesh);

      // Larger invisible hit target for easy hand/mouse selection
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.copy(mesh.position);
      hit.userData.target = body;
      this.planetGroup.add(hit);
      this.clickableMeshes.push(hit);

      const lbl = makeTextSprite(body.name, { fontSize: 22, color: '#dbe7f3', bgColor: 'rgba(7, 12, 24, 0.35)', borderColor: null, scale: 1.8 });
      lbl.position.set(body.pos.x, body.pos.y + 2.4, body.pos.z);
      this.labelGroup.add(lbl);
      const entry = { target: body, mesh, hit, label: lbl };
      this._bodyEntries.push(entry);
      this._bodyByName.set(body.name, entry);
    }

    // Named bright stars (clickable + labeled for top brightest). Built for every named star so
    // rotated-in stars are selectable/labelled; horizon visibility applied below.
    for (const star of snapshot.allNamedStars || snapshot.visibleNamedStars) {
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.set(star.pos.x, star.pos.y, star.pos.z);
      hit.userData.target = star;
      this.starHitGroup.add(hit);
      this.clickableMeshes.push(hit);

      let lbl = null;
      if (star.mag <= 1.35) {
        lbl = makeTextSprite(star.name, {
          fontSize: 22,
          color: '#cbd5e1',
          bgColor: 'rgba(8, 15, 30, 0.35)',
          borderColor: null,
          scale: 1.7
        });
        lbl.position.set(star.pos.x, star.pos.y + 1.9, star.pos.z);
        lbl.material.opacity = this._dayFade ?? 1;
        this.celestialLabelGroup.add(lbl);
        this._labelSprites.push(lbl);
      }
      this._starEntries.push({ target: star, hit, label: lbl });
    }

    // Constellation labels
    if (showConstellations) {
      for (const c of snapshot.allConstellationLabels || snapshot.constellationLabels) {
        const lbl = makeTextSprite(c.name.toUpperCase(), {
          fontSize: 20,
          color: '#cfd8e6',
          bgColor: 'rgba(8, 15, 30, 0.25)',
          borderColor: null,
          scale: 1.5
        });
        lbl.position.set(c.pos.x, c.pos.y, c.pos.z);
        this.celestialLabelGroup.add(lbl);
        const k = this._constIdx.get(c.name);
        lbl.userData.baseX = lbl.scale.x;
        lbl.userData.baseY = lbl.scale.y;
        lbl.userData.constIdx = k === undefined ? -1 : k;
        lbl.userData.lastW = -1;
        this._labelSprites.push(lbl);
        this._constLabelEntries.push({ target: c, sprite: lbl });
        this._applyLabelWeight(lbl, k === undefined ? 0 : this._weights[k]);
      }
    }
    this._applyCelestialVisibility();
    // Rebind a selected planet to the rebuilt target object so the ring keeps following it.
    if (this._selected) this._selected = this._bodyByName.get(this._selected.name)?.target ?? null;
  }

  _applyLabelWeight(lbl, w) {
    const ud = lbl.userData;
    if (Math.abs(ud.lastW - w) < 0.002) return;
    ud.lastW = w;
    ud.w = w;
    // hidden below w~0.12 to declutter; silvery and brighter toward the view centre
    const vis = Math.min(1, Math.max(0, (w - 0.12) / 0.1));
    lbl.material.opacity = vis * (0.3 + 0.7 * w) * (this._dayFade ?? 1);
    const sc = 0.9 + 0.3 * w;
    lbl.scale.set(ud.baseX * sc, ud.baseY * sc, 1);
  }

  getFocusedConstellation() {
    return this.constLines.focusName;
  }

  _clearGroup(group) {
    while (group.children.length > 0) {
      const child = group.children[0];
      group.remove(child);
      if (child.isSprite) {
        child.material.map?.dispose();
        child.material.dispose();
      } else if (child.isMesh && !child.userData.keepGpu) {
        if (child.geometry !== this._hitGeo) child.geometry.dispose();
        if (child.material !== this._hitMat) child.material.dispose();
      }
    }
  }

  /** Load takram's physical sky tables and switch the dome to them (gradient sky stays on failure, or with ?atmo=0). */
  async enableAtmosphere(renderer) {
    if (new URLSearchParams(location.search).get('atmo') === '0') return false;
    const atmo = await Atmosphere.load(renderer);
    if (!atmo) return false;
    this.domeSky.enableAtmosphere(atmo);
    this._applyCelestialVisibility();
    if (this.nightMode) this.domeSky.setNightMode(true);
    return true;
  }

  setNightMode(enabled) {
    this.nightMode = enabled;
    this.selectionRing.material.uniforms.uColor.value.set(enabled ? 0xe0503f : 0x8fe3f5);
    this.starField.setNightMode(enabled);
    this.starTrails.setNightMode(enabled);
    this.constLines.setNightMode(enabled);
    this.domeSky.setNightMode(enabled);
    this.compass.setNightMode(enabled);
  }

  setARMode(isAR) {
    this.isAR = isAR;
    // AR passthrough must stay see-through; otherwise the dome covers everything.
    this.domeSky.setVisible(!isAR);
    this.scene.background = null;
    const clip = !isAR;
    const changed = clip !== this.clipHorizon;
    this.clipHorizon = clip;
    this.starField.setHorizonClip(clip);
    this.starTrails.setHorizonClip(clip);
    this.lineMaterial.uniforms.uHorizonClip.value = clip ? 1 : 0;
    if (changed) this._applyCelestialVisibility(); // all items always exist; only visibility differs
  }

  /** Per-frame: dome follows the (XR or desktop) camera; sun glow follows calibration yaw. */
  tick(dt, camera) {
    this.skyRoot.getWorldQuaternion(this._skyQuat);
    camera.getWorldPosition(this._camPos);
    this.domeSky.update(dt, this._camPos, this._skyQuat);
    this.starField.update(dt);
    this.starTrails.update(dt);
    this._updateMoon();
    if (this.selectionRing.visible) {
      this.selectionRing.material.uniforms.uAngle.value += dt * 0.14; // slow drift (~8 deg/s)
      this.selectionRing.lookAt(this._camPos);
    }
    this._updateFocus(dt, camera);
    if (this._ringDirty) {
      this._ringDirty = false;
      if (this.selectionRing.visible) this.selectionRing.lookAt(this._camPos);
    }
  }

  _updateMoon() {
    const e = this._bodyByName.get('Moon');
    if (!e) return;
    this._sunWorld.copy(this._sunLocal).applyQuaternion(this._skyQuat);
    const m = e.target.pos;
    const len = Math.hypot(m.x, m.y, m.z) || 1;
    const cosE = (m.x * this._sunLocal.x + m.y * this._sunLocal.y + m.z * this._sunLocal.z) / len;
    const phase = (1 - cosE) / 2; // illuminated fraction from the Sun–Moon elongation
    this.moonPhase = phase;
    this.moonAlt = e.target.alt;
    this.moon.update(this._sunWorld, phase, this._dayFadeNow ?? 1, !!this.nightMode);
  }

  _updateFocus(dt, camera) {
    if (!this._constNames.length) return;
    // Gaze in skyRoot-local space
    camera.getWorldDirection(this._gaze);
    this._invQuat.copy(this._skyQuat).invert();
    this._gaze.applyQuaternion(this._invQuat);
    // ...then into celestialGroup-local space (centroids are stored unrotated)
    this._gaze.applyQuaternion(this._celInv);
    // vertical FOV from the projection matrix (valid for desktop and the XR array camera)
    const e5 = camera.projectionMatrix.elements[5];
    const fov = e5 > 0 ? 2 * Math.atan(1 / e5) * (180 / Math.PI) : 65;
    this.constLines.update(dt, this._gaze, this._rowY, this.clipHorizon, this._lastShowConst && !!this._lastSnapshot, fov);
    const w = this._weights;
    const labels = this._labelSprites;
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i];
      const k = l.userData.constIdx;
      if (k >= 0) this._applyLabelWeight(l, w[k]);
    }
  }

  dispose() {
    this._clearGroup(this.planetGroup);
    this._clearGroup(this.labelGroup);
    this._clearGroup(this.starHitGroup);
    this._clearGroup(this.celestialLabelGroup);
    this._hitGeo.dispose();
    this._hitMat.dispose();
    this.domeSky.dispose();
    this.compass.dispose();
    this.starField.dispose();
    this.starTrails.dispose();
    this.constLines.dispose();
    this.moon.dispose();
    this.selectionRing.geometry.dispose();
    this.selectionRing.material.dispose();
    this.scene.remove(this.skyRoot);
  }

  /** Limiting magnitude: stars fainter than this fade out, and cannot be picked. */
  setMagLimit(m) {
    this.magLimit = m;
    this.starField.setMagLimit(m);
    this.starTrails.setMagLimit(m);
  }

  /**
   * Pick ANY catalogue star (all 5,044 naked-eye stars) nearest to a world-space direction, by angle,
   * slightly favouring brighter stars. Returns a selection target (pos in celestialGroup-local space) or null.
   */
  pickStar(dirWorld, fovDeg = 65) {
    const snap = this._lastSnapshot;
    if (!snap) return null;
    const P = snap.starPositions;
    const stars = this.catalog.stars;
    // world -> celestialGroup local
    this.celestialGroup.getWorldQuaternion(this._pickQ).invert();
    const d = this._pickV.copy(dirWorld).normalize().applyQuaternion(this._pickQ);
    const maxDeg = Math.max(0.8, fovDeg * 0.022);
    const cosMax = Math.cos(maxDeg * Math.PI / 180);
    let best = -1, bestScore = Infinity;
    const R = SKY_RADIUS;
    for (let i = 0; i < stars.length; i++) {
      const c = (P[i * 3] * d.x + P[i * 3 + 1] * d.y + P[i * 3 + 2] * d.z) / R;
      if (c < cosMax) continue;
      if (stars[i].mag > (this.magLimit ?? 9) + 0.2) continue; // not drawn -> not pickable
      const ang = Math.acos(Math.min(1, c)) * 180 / Math.PI;
      const score = ang / maxDeg + 0.06 * stars[i].mag; // a bright star wins over a slightly closer faint one
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) return null;
    const st = stars[best];
    const pos = { x: P[best * 3], y: P[best * 3 + 1], z: P[best * 3 + 2] };
    // alt/az in the current (possibly scrub-rotated) sky
    const w = this._pickV2.set(pos.x, pos.y, pos.z).applyQuaternion(this.celestialGroup.quaternion);
    const alt = Math.asin(Math.max(-1, Math.min(1, w.y / R))) * 180 / Math.PI;
    const az = ((Math.atan2(w.x, -w.z) * 180 / Math.PI) + 360) % 360;
    const ids = [st.name && st.bayer ? `${st.bayer} ${st.constellation}` : '', st.hip, st.hd].filter(Boolean);
    return {
      kind: 'star',
      name: starDisplayName(st),
      subtitle: [describeStarColour(st.bv), st.conName ? `in ${st.conName}` : ''].filter(Boolean).join(' '),
      mag: st.mag,
      extra: `Mag ${st.mag.toFixed(2)}${st.bv !== null ? ` • B−V ${st.bv.toFixed(2)}` : ''}<br/>${ids.join(' • ')}`,
      alt,
      az,
      pos
    };
  }

  highlightTarget(target, cameraPos) {
    if (!target) {
      this.selectionRing.visible = false;
      this._selected = null;
      return;
    }
    // Fixed-star targets ride the celestial rotation; bodies are placed exactly in skyRoot space.
    const parent = target.kind === 'planet' ? this.skyRoot : this.celestialGroup;
    if (this.selectionRing.parent !== parent) parent.add(this.selectionRing);
    this._selected = target.kind === 'planet' ? (this._bodyByName.get(target.name)?.target ?? target) : null;
    this.selectionRing.position.set(target.pos.x, target.pos.y, target.pos.z);
    this.selectionRing.lookAt(cameraPos);
    this.selectionRing.visible = true;
  }
}
