import * as THREE from 'three';

/**
 * Photometric star field: one THREE.Points draw call.
 *
 * Look model (device pixels x uPixelScale = max(1, bufferHeight/1000)):
 *   lum   = 1.22*flux^0.42 (mag6 .12, mag4 .26, mag1.5 .56, mag0 1.22, Sirius 2.15)
 *   core  : Gaussian, sigma .9..1.8 px (smoothstep of lum), amplitude clamp(.35+.74*(lum-.12),0,1)  (mag6 .35, mag4 .45, mag0 1)
 *   halo  : exp(-r/(.38*rh)), rh = 2+9*min(lum,1.4) px (mag0 ~13), peak .45*(lum/1.22)^1.3 capped x1.2^1.3
 *   extinction / twinkle (0.02 at zenith -> .32 near horizon) / colour flicker as before.
 */
const STAR_VERT = /* glsl */ `
  attribute float aMag;
  attribute vec3 aColor;
  attribute vec2 aRand;
  uniform float uTime;
  uniform float uPixelScale;
  varying vec3 vCore;
  varying vec3 vHalo;
  varying float vAlt;
  varying float vSize;
  varying float vSigma;
  varying float vRh;
  varying float vAmpC;
  varying float vAmpH;
  void main() {
    vAlt = normalize((modelMatrix * vec4(position, 1.0)).xyz).y; // world space: celestialGroup may be rotated
    float lum = 1.45 * pow(10.0, -0.168 * aMag); // 1.22*flux^0.42: mag6 .12, mag4 .26, mag0 1.22, Sirius 2.15
    float sa = max(vAlt, 0.0);
    float X = min(1.0 / (sa + 0.04), 10.0);
    float dX = max(X - 1.0, 0.0);
    vec3 trans = exp(-0.921 * vec3(0.10, 0.16, 0.26) * dX);

    // ---- Scintillation, as the naked eye sees it ----
    // Brightness twinkle: a pseudo-noise of 4 incommensurate sines per star; small overhead, strong low down.
    float ph = aRand.x * 6.2831853;
    float fq = 0.75 + 0.6 * aRand.y;
    float t = uTime * fq;
    float n0 = 0.40 * sin(t * 4.1 + ph) + 0.30 * sin(t * 7.3 + ph * 1.7) + 0.20 * sin(t * 11.9 + ph * 2.9) + 0.10 * sin(t * 17.3 + ph * 4.1);
    float altF = clamp(dX / 5.0, 0.0, 1.0);
    float sA = 0.06 + 0.34 * altF;
    float tw = max(0.15, 1.0 + sA * n0);
    // Colour twinkle (atmospheric dispersion): bright WHITE/blue-white stars flash through colours
    // (Sirius, Vega, Rigel low down), red giants (Betelgeuse, Aldebaran, Antares) stay their colour.
    float redness = clamp((aColor.r - aColor.b) * 2.2, 0.0, 1.0);
    float bright = smoothstep(2.2, -0.5, aMag);                // mag ~2 -> 0, Sirius -> 1
    float cf = bright * (0.25 + 0.75 * altF) * (1.0 - 0.85 * redness);
    vec3 chroma = vec3(
      sin(t * 5.3 + ph * 3.1) + 0.5 * sin(t * 13.1 + ph * 1.3),
      sin(t * 6.1 + ph * 5.3 + 2.1) + 0.5 * sin(t * 14.7 + ph * 2.2),
      sin(t * 4.7 + ph * 7.7 + 4.2) + 0.5 * sin(t * 12.3 + ph * 3.7)) / 1.5;
    vec3 flick = max(vec3(0.0), 1.0 + 0.75 * cf * chroma);

    vec3 sat = clamp(mix(vec3(dot(aColor, vec3(0.333))), aColor, 1.7), 0.0, 1.0);
    vCore = mix(vec3(1.0), sat, 0.32) * trans * flick;   // cores keep a hint of the star's colour
    vHalo = sat * trans * flick;
    vAmpC = clamp(0.55 + 0.8 * (lum - 0.12), 0.0, 1.35) * tw;
    vAmpH = 0.6 * pow(min(lum / 1.22, 1.3), 1.2) * tw;

    float sc = uPixelScale;
    vSigma = (0.95 + 1.0 * smoothstep(0.1, 0.9, lum)) * sc;
    vRh = (2.0 + 9.0 * min(lum, 1.4)) * sc;
    float half_ = max(vSigma * 3.5, vRh * 2.4) + 1.0;
    vSize = min(2.0 * half_, 128.0);
    gl_PointSize = vSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const STAR_FRAG = /* glsl */ `
  uniform float uNightMode;
  uniform float uDayFade;
  uniform float uHorizonClip;
  varying vec3 vCore;
  varying vec3 vHalo;
  varying float vAlt;
  varying float vSize;
  varying float vSigma;
  varying float vRh;
  varying float vAmpC;
  varying float vAmpH;
  void main() {
    float r = length(gl_PointCoord - vec2(0.5)) * vSize;
    float half_ = 0.5 * vSize;
    float core = vAmpC * exp(-0.5 * r * r / (vSigma * vSigma));
    float halo = vAmpH * exp(-r / (0.38 * vRh));
    float edge = 1.0 - smoothstep(0.65 * half_, half_, r);
    vec3 col = (vCore * core + vHalo * halo) * edge;
    float l = dot(col, vec3(0.3, 0.59, 0.11));
    col = mix(col, vec3(1.0, 0.22, 0.18) * l * 1.2, uNightMode);
    float clip = mix(1.0, smoothstep(-0.01, 0.02, vAlt), uHorizonClip);
    gl_FragColor = vec4(col * uDayFade * clip, 1.0); // additive: SRC_ALPHA(=1) * rgb + dst
  }
`;

export class StarField {
  /** @param {Array<{mag:number, rgb:number[]}>} stars catalog.stars (same order as snapshot.starPositions) */
  constructor(stars) {
    const count = stars.length;
    const geo = new THREE.BufferGeometry();
    const colors = new Float32Array(count * 3);
    const mags = new Float32Array(count);
    const rand = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      const s = stars[i];
      colors[i * 3] = s.rgb[0];
      colors[i * 3 + 1] = s.rgb[1];
      colors[i * 3 + 2] = s.rgb[2];
      mags[i] = s.mag;
      rand[i * 2] = Math.random();
      rand[i * 2 + 1] = Math.random();
    }
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(mags, 1));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 2));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uNightMode: { value: 0 },
        uDayFade: { value: 1 },
        uHorizonClip: { value: 1 },
        uTime: { value: 0 },
        uPixelScale: { value: 1 }
      },
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;
    this._v2 = new THREE.Vector2();
    this.time = 0;
    // Pixel scale follows the actual render target (XR eye buffer or canvas) at draw time.
    this.points.onBeforeRender = (renderer, _scene, camera) => this._syncScale(renderer, camera);
  }

  _syncScale(renderer, camera) {
    let h = 0;
    if (camera && camera.isArrayCamera && camera.cameras.length) h = camera.cameras[0].viewport.w;
    else if (renderer) h = renderer.getDrawingBufferSize(this._v2).y;
    if (h > 0) this.material.uniforms.uPixelScale.value = Math.max(1, h / 1000);
  }

  /** Positions come from the snapshot (radius SKY_RADIUS, observer frame). */
  setPositions(arr) {
    const a = this.points.geometry.getAttribute('position');
    a.array.set(arr);
    a.needsUpdate = true;
  }

  update(dt, camera, renderer) {
    this.time = (this.time + dt) % 3600; // wrap keeps float precision for sin()
    this.material.uniforms.uTime.value = this.time;
    if (renderer) this._syncScale(renderer, camera);
  }

  setDayFade(f) { this.material.uniforms.uDayFade.value = f; }
  setHorizonClip(on) { this.material.uniforms.uHorizonClip.value = on ? 1 : 0; }
  setNightMode(on) { this.material.uniforms.uNightMode.value = on ? 1 : 0; }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
