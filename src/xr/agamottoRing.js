import * as THREE from 'three';

// Doctor-Strange mandala shown around the scrubbing hand. Procedural (one shader, one quad per ring layer).
const DIAMETER = 0.14; // metres
const FADE_IN_S = 0.12;
const FADE_OUT_S = 0.3;
const LINGER_S = 0.6; // stays after release while the dial coasts/settles
const LABEL_W = 512;
const LABEL_H = 128;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

// uLayer: 0 = outer rune ring, 1 = inner hour ring (rotates with dial), 2 = core glow
const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uLayer, uRot, uTime, uStrain, uFlash, uAlpha;
uniform vec3 uColor, uHot;
const float PI = 3.14159265;
float ring(float r, float c, float w) { return smoothstep(w, 0.0, abs(r - c)); }
float hash(float n) { return fract(sin(n * 91.345) * 47453.5453); }
void main() {
  float r = length(vUv);
  if (r > 1.0) discard;
  float a = atan(vUv.x, vUv.y); // 0 at top, clockwise +
  float ar = a - uRot; // angle in the layer's rotating frame
  float v = 0.0;
  float jitter = uStrain * (hash(floor(uTime * 24.0) + floor((a + PI) * 14.0)) - 0.5) * 0.03;
  float rr = r + jitter;
  if (uLayer < 0.5) {
    // outer runes: thin double circle + dashed glyph-like segments with ticks
    v += ring(rr, 0.97, 0.012) * 0.9 + ring(rr, 0.84, 0.008) * 0.7;
    float seg = fract(ar * 16.0 / (2.0 * PI));
    float cell = floor(ar * 16.0 / (2.0 * PI));
    float h = hash(cell);
    float band = smoothstep(0.075, 0.0, abs(rr - 0.905));
    float glyph = step(0.12, seg) * step(seg, 0.88) * step(0.25, h);
    // a cross-bar / diagonal stroke inside each cell makes it read as a rune
    float stroke = smoothstep(0.1, 0.0, abs(fract(seg * 2.0 + h) - 0.5) - 0.28 + (rr - 0.905) * 1.5);
    v += band * glyph * (0.35 + 0.65 * stroke);
    v += step(0.0, fract(ar * 48.0 / (2.0 * PI)) - 0.88) * ring(rr, 0.93, 0.05) * 0.8;
  } else if (uLayer < 1.5) {
    // inner dial: 24 hour ticks (every 6th long), dashed arc
    float t = fract(ar * 24.0 / (2.0 * PI));
    float tick = smoothstep(0.035, 0.0, min(t, 1.0 - t));
    float major = step(fract(ar * 4.0 / (2.0 * PI)), 0.015) + step(0.985, fract(ar * 4.0 / (2.0 * PI)));
    float len = mix(0.09, 0.16, clamp(major, 0.0, 1.0));
    v += tick * step(abs(rr - 0.72), len * 0.5) * 0.95;
    v += ring(rr, 0.82, 0.01) * 0.8 + ring(rr, 0.62, 0.01) * 0.8;
    float dash = step(0.5, fract(ar * 60.0 / (2.0 * PI)));
    v += dash * ring(rr, 0.55, 0.012) * 0.6;
    // fixed marker at the top: the tick under it is the shown time
    float m = smoothstep(0.06, 0.0, abs(a)) * ring(rr, 0.9, 0.08);
    v += m * 1.2;
  } else {
    // core: soft glow + pulse
    v += smoothstep(0.5, 0.0, rr) * 0.22 + ring(rr, 0.28, 0.01) * 0.6;
  }
  // global soft halo
  float halo = smoothstep(1.0, 0.45, r) * 0.04;
  vec3 col = mix(uColor, uHot, clamp(uStrain, 0.0, 1.0));
  // strain shimmer
  float shim = 1.0 + uStrain * 0.5 * sin(uTime * 40.0 + a * 12.0);
  col = mix(col, vec3(0.9, 0.97, 1.0), uFlash * 0.7);
  float alpha = (v * shim + halo) * (1.0 + uFlash * 1.5) * uAlpha;
  gl_FragColor = vec4(col * alpha, alpha);
}
`;

const PAL = {
  day: { color: new THREE.Color(0.66, 0.86, 0.95), hot: new THREE.Color(0.95, 0.64, 0.63), text: '#dbe7f3' },
  night: { color: new THREE.Color(0.75, 0.12, 0.08), hot: new THREE.Color(1.0, 0.1, 0.05), text: '#e0604f' }
};

export class AgamottoRing {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.group.renderOrder = 999;
    this.alpha = 0;
    this.time = 0;
    this.flash = 0;
    this.lastShift = null;
    this.lastNight = null;
    this.lastText = '';
    this.strain = 0;

    this.geo = new THREE.PlaneGeometry(DIAMETER, DIAMETER);
    this.mats = [];
    this.layers = [];
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uLayer: { value: i },
          uRot: { value: 0 },
          uTime: { value: 0 },
          uStrain: { value: 0 },
          uFlash: { value: 0 },
          uAlpha: { value: 0 },
          uColor: { value: PAL.day.color.clone() },
          uHot: { value: PAL.day.hot.clone() }
        }
      });
      const m = new THREE.Mesh(this.geo, mat);
      m.renderOrder = 999 + i;
      m.position.z = i * 0.0005;
      m.frustumCulled = false;
      this.group.add(m);
      this.mats.push(mat);
      this.layers.push(m);
    }

    // Label texture below the ring.
    this.canvas = document.createElement('canvas');
    this.canvas.width = LABEL_W;
    this.canvas.height = LABEL_H;
    this.ctx = this.canvas.getContext('2d');
    this.labelTex = new THREE.CanvasTexture(this.canvas);
    this.labelTex.colorSpace = THREE.SRGBColorSpace;
    this.labelMat = new THREE.MeshBasicMaterial({
      map: this.labelTex, transparent: true, depthTest: false, depthWrite: false, opacity: 0
    });
    this.labelGeo = new THREE.PlaneGeometry(0.12, 0.03);
    this.label = new THREE.Mesh(this.labelGeo, this.labelMat);
    this.label.position.set(0, -DIAMETER / 2 - 0.022, 0.001);
    this.label.renderOrder = 1003;
    this.group.add(this.label);

    scene.add(this.group);
  }

  update(dt, { visible, position, quaternion, state, nightMode } = {}) {
    this.linger = visible ? LINGER_S : Math.max(0, (this.linger || 0) - dt);
    const target = visible || this.linger > 0 ? 1 : 0;
    const step = dt / (target > this.alpha ? FADE_IN_S : FADE_OUT_S);
    this.alpha += Math.sign(target - this.alpha) * Math.min(Math.abs(target - this.alpha), step);
    this.group.visible = this.alpha > 0.002;
    if (!this.group.visible) { this.lastShift = null; return; }
    this.time += dt;
    if (position) this.group.position.copy(position);
    if (quaternion) this.group.quaternion.copy(quaternion);

    const s = state || {};
    const pal = nightMode ? PAL.night : PAL.day;
    const edgeRes = s.edge && s.edge !== 'none' ? s.resistance || 0 : 0;
    this.strain += (edgeRes - this.strain) * Math.min(1, dt * 14);

    if (this.lastShift !== null && s.dayShift !== this.lastShift) this.flash = 1;
    this.lastShift = s.dayShift ?? 0;
    this.flash = Math.max(0, this.flash - dt * 2.5);

    const rot = ((s.dialAngleDeg || 0) * Math.PI) / 180;
    const rotIn = rot;
    const rotOut = -this.time * 0.15;
    const rots = [rotOut, rotIn, 0];
    // Subtle breathing on scale; strain adds shake.
    const shake = this.strain * 0.003;
    for (let i = 0; i < 3; i++) {
      const u = this.mats[i].uniforms;
      u.uRot.value = rots[i];
      u.uTime.value = this.time;
      u.uStrain.value = this.strain;
      u.uFlash.value = this.flash;
      u.uAlpha.value = this.alpha;
      if (nightMode !== this.lastNight) {
        u.uColor.value.copy(pal.color);
        u.uHot.value.copy(pal.hot);
      }
    }
    if (this.strain > 0.02) {
      this.layers[0].position.x = (Math.random() - 0.5) * shake;
      this.layers[0].position.y = (Math.random() - 0.5) * shake;
    } else {
      this.layers[0].position.x = this.layers[0].position.y = 0;
    }
    const sc = 1 + this.flash * 0.12 + Math.sin(this.time * 2) * 0.008;
    this.group.scale.setScalar(sc);

    const text = `${s.label || ''}|${s.relLabel || ''}|${nightMode ? 1 : 0}`;
    if (text !== this.lastText || nightMode !== this.lastNight) {
      this.lastText = text;
      this.drawLabel(s.label || '', s.relLabel || '', pal.text);
    }
    this.lastNight = nightMode;
    this.labelMat.opacity = this.alpha;
  }

  drawLabel(label, rel, color) {
    const c = this.ctx;
    c.clearRect(0, 0, LABEL_W, LABEL_H);
    c.fillStyle = 'rgba(7, 12, 24, 0.6)';
    c.beginPath();
    c.roundRect(8, 8, LABEL_W - 16, LABEL_H - 16, 28);
    c.fill();
    c.strokeStyle = color;
    c.globalAlpha = 0.5;
    c.lineWidth = 2;
    c.stroke();
    c.globalAlpha = 1;
    c.fillStyle = color;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = '600 44px -apple-system, BlinkMacSystemFont, sans-serif';
    c.fillText(label, LABEL_W / 2, rel ? 46 : 64, LABEL_W - 40);
    if (rel) {
      c.globalAlpha = 0.75;
      c.font = '500 30px -apple-system, BlinkMacSystemFont, sans-serif';
      c.fillText(rel, LABEL_W / 2, 92, LABEL_W - 40);
      c.globalAlpha = 1;
    }
    this.labelTex.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.group);
    for (const m of this.mats) m.dispose();
    this.geo.dispose();
    this.labelGeo.dispose();
    this.labelMat.dispose();
    this.labelTex.dispose();
  }
}
