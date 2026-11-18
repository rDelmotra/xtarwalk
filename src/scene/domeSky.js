import * as THREE from 'three';
import { ATMOSPHERE_GLSL, ATMOSPHERE_DEFINES } from './atmosphere.js';

// Ported from orbitwatch DomeSkyLayer.ts: analytic sky gradient + twilight glow + Gerstner sea
// (Fresnel-reflecting the sky, with sun glitter) + procedural horizon ridge.
// Frame: Xtarwalk2 is observer-centred, +Y = zenith, +X = East, -Z = North.

/** Inside the camera far plane (250), outside the star sphere (SKY_RADIUS = 80). */
const DOME_RADIUS = 200;

const SKY_VERT = /* glsl */ `
varying vec3 vWorldPos;

void main() {
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3  uUp;      // observer zenith, scene frame
uniform vec3  uSunDir;  // sun unit vector, scene frame
uniform float uTime;    // seconds (wall‑clock accumulator) — drives the waves
uniform float uNight;   // 1 = red night-vision mode

varying vec3 vWorldPos;

const float EYE_HEIGHT_M = 2.0;                  // artistic eye height above the sea

#ifdef ATMO
uniform vec3  uAtmoCam;      // observer position, takram length units (km), Earth centre at origin
uniform float uExposure;
uniform vec3  uWhiteBalance;
uniform vec3  uSunTint;      // sunlight colour after the air (reddens at the horizon), max channel 1
uniform float uSunVisible;   // 0 below the horizon .. 1 once the disc has cleared it

// takram/Bruneton sky luminance, white-balanced and exposed (still HDR).
vec3 skyHDR(vec3 dir, out vec3 transmittance) {
  vec3 d = normalize(vec3(dir.x, max(dir.y, 0.0005), dir.z)); // never ask for a ray into the ground
  vec3 L = GetSkyRadiance(uAtmoCam, d, 0.0, normalize(uSunDir), transmittance);
  return L * uWhiteBalance * uExposure;
}

// Display mapping: hue-keeping highlight roll-off (orbitwatch's ground camera), ACES filmic, sRGB encode.
vec3 acesFilmic(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
vec3 toDisplay(vec3 col) {
  float Y = dot(col, vec3(0.2126, 0.7152, 0.0722));
  const float knee = 0.6, roll = 0.05;
  if (Y > knee) col *= (knee + roll * log(1.0 + (Y - knee) / roll)) / Y;
  col = acesFilmic(col);
  return pow(col, vec3(1.0 / 2.2));
}

// Faint navy night floor (airglow + light pollution), so the night sky and the ridge never read as a void.
vec3 nightFloor(vec3 dir) {
  float night = 1.0 - smoothstep(-0.30, -0.08, dot(normalize(uSunDir), uUp));
  float g = smoothstep(0.0, 0.5, max(dir.y, 0.0));
  return night * mix(vec3(0.030, 0.042, 0.085), vec3(0.008, 0.013, 0.032), g);
}

vec3 skyColor(vec3 dir) {
  vec3 T;
  return toDisplay(skyHDR(dir, T)) + nightFloor(dir);
}

// Sky plus the Sun: the true-size disc (takram's solar luminance through the air) and a soft glare
// tinted by the sunlight colour, like orbitwatch's ground sun.
vec3 skyWithSun(vec3 dir) {
  vec3 T;
  vec3 col = skyHDR(dir, T);
  vec3 s = normalize(uSunDir);
  float cosA = dot(dir, s);
  float ang = acos(clamp(cosA, -1.0, 1.0));
  float fragAngle = length(fwidth(dir));
  float R = ATMOSPHERE.sun_angular_radius * 1.6;  // a touch larger than true so it reads in a headset
  float disc = smoothstep(R, R - max(fragAngle, 1e-4), ang);
  col += T * GetSolarRadiance() * uWhiteBalance * uExposure * disc * 0.02;
  float glare = exp(-ang / 0.02) * 6.0 + 0.6 * exp(-ang / 0.12);
  col += uSunTint * glare * uSunVisible;
  return toDisplay(col) + nightFloor(dir);
}
#else
// Pure upper‑hemisphere sky colour for any direction. No below‑horizon term — that's
// the sea (below). Reused by the sea as its reflection source.
vec3 skyColor(vec3 dir) {
  float elev    = dot(dir, uUp);
  float sunElev = dot(uSunDir, uUp);
  float dayness = smoothstep(-0.18, 0.10, sunElev);

  vec3 zenithDay    = vec3(0.18, 0.42, 0.82);
  vec3 horizonDay   = vec3(0.62, 0.76, 0.92);
  vec3 zenithNight  = vec3(0.012, 0.020, 0.055);
  vec3 horizonNight = vec3(0.040, 0.060, 0.130);
  vec3 zenithColor  = mix(zenithNight, zenithDay, dayness);
  vec3 horizonColor = mix(horizonNight, horizonDay, dayness);

  float g = smoothstep(0.0, 0.55, max(elev, 0.0));
  vec3 col = mix(horizonColor, zenithColor, g);

  // Warm twilight glow toward the sun, civil‑twilight gated (sunElev = sin altitude).
  float towardSun        = max(dot(dir, normalize(uSunDir)), 0.0);
  float twilightWindow   = smoothstep(-0.12, -0.02, sunElev) * (1.0 - smoothstep(0.02, 0.12, sunElev));
  float horizonProximity = 1.0 - smoothstep(0.0, 0.32, abs(elev));
  col += vec3(1.0, 0.46, 0.20) * (pow(towardSun, 3.0) * twilightWindow * horizonProximity) * 0.6;
  return col;
}
vec3 skyWithSun(vec3 dir) { return skyColor(dir); }
#endif

// One Gerstner wave's contribution to the surface normal (height‑field form):
// returns (∂east, up‑term, ∂north) accumulated into the tangent‑frame normal.
vec3 waveContribution(vec2 p, vec2 dir, float L, float A, float Q, float spd, float flatten) {
  vec2  D  = normalize(dir);
  float k  = 6.2831853 / L;
  float ph = k * dot(D, p) + uTime * spd;
  float WA = k * A * flatten;
  return vec3(-D.x * WA * cos(ph), -Q * WA * sin(ph), -D.y * WA * cos(ph));
}

// Ambient Gerstner sea for a below‑horizon ray (elev < 0): Fresnel‑reflects the sky.
vec3 seaColor(vec3 viewDir, float elev, vec3 east, vec3 north) {
  float down = max(-elev, 1e-4);
  float t    = EYE_HEIGHT_M / down;     // metres along the ray to the water
  vec3  hit  = viewDir * t;             // offset from the eye, metres
  vec2  p    = vec2(dot(hit, east), dot(hit, north));

  // Flatten waves toward the horizon (far + grazing) to kill shimmer/aliasing.
  float flatten = smoothstep(0.0, 0.14, -elev);

  vec3 g = vec3(0.0, 1.0, 0.0);
  g += waveContribution(p, vec2( 1.0,  0.6), 6.0, 0.100, 0.5, 0.9, flatten);
  g += waveContribution(p, vec2(-0.7,  1.0), 3.1, 0.050, 0.5, 1.2, flatten);
  g += waveContribution(p, vec2( 0.3, -1.0), 1.7, 0.025, 0.4, 1.6, flatten);
  g += waveContribution(p, vec2(-1.0, -0.4), 0.9, 0.012, 0.3, 2.1, flatten);
  vec3 N = normalize(east * g.x + uUp * g.y + north * g.z);

  vec3  V       = -viewDir;
  float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3  reflDir = reflect(viewDir, N);
  vec3  refl    = skyColor(reflDir);

  float sunElev = dot(uSunDir, uUp);
  float dayness = smoothstep(-0.18, 0.10, sunElev);
  vec3  deep    = mix(vec3(0.020, 0.050, 0.075), vec3(0.06, 0.16, 0.21), dayness);

  vec3 color = mix(deep, refl, clamp(fresnel + 0.06, 0.0, 1.0));

  float glitter = pow(max(dot(reflDir, normalize(uSunDir)), 0.0), 120.0);
  float sunUp   = smoothstep(-0.05, 0.10, sunElev);
  color += vec3(1.0, 0.9, 0.7) * glitter * sunUp * 0.8;
  return color;
}

// Hash + value noise, sampled on a circle so the ridgeline is seamless around the
// horizon (no seam at due north) and irregular — not a periodic "frequency map".
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Procedural ridgeline silhouette height (sin of elevation) vs azimuth. Ridged fBm of
// value noise → irregular, sharp-crested distant mountains (not dunes, not ripples).
float mountainTop(float az) {
  vec2 q = vec2(cos(az), sin(az)) * 5.0;     // circle radius ~ ridge count around horizon
  float h = 0.0;
  float amp = 0.5;
  for (int k = 0; k < 5; k++) {
    float n = vnoise2(q);
    h += amp * (1.0 - abs(2.0 * n - 1.0));   // ridged: sharp crests, cut valleys
    q *= 2.0;
    amp *= 0.5;
  }
  h = pow(clamp(h, 0.0, 1.0), 1.6);          // sharpen peaks / flatten valleys
  return mix(0.006, 0.038, h);               // toned-down height (~0.3°..2.2°)
}

void main() {
  vec3  viewDir = normalize(vWorldPos - cameraPosition);
  float elev    = dot(viewDir, uUp);   // 1 = zenith, 0 = horizon, <0 = below

  // Local tangent basis (azimuth + wave coords).
  // Xtarwalk frame: +X = East, -Z = North, +Y = zenith (fixed; the dome never yaws).
  vec3 east  = vec3(1.0, 0.0, 0.0);
  vec3 north = vec3(0.0, 0.0, -1.0);

  // Base scene: sky above the horizon, ambient sea below.
  vec3 color = (elev >= 0.0) ? skyWithSun(viewDir) : seaColor(viewDir, elev, east, north);

  // ── Procedural horizon mountains — a low silhouette covering the seam ────────
  // The ridge rises ~1‑3° above the horizon and its foot sits ~3° BELOW it, fading
  // into the sea (perceived "submerged / emerging from the water" base).
  const float FOOT = -0.05;                         // submerged foot (sin ≈ -3°)
  float az  = atan(dot(viewDir, east), dot(viewDir, north));
  float top = mountainTop(az);
  float ridge     = smoothstep(top, top - 0.004, elev);  // 1 below the ridgeline
  float depthFade = smoothstep(FOOT, 0.0, elev);         // fade out below the waterline
  float mtnAlpha  = ridge * depthFade;

  float ds = smoothstep(-0.18, 0.10, dot(uSunDir, uUp));
  vec3  mountainColor = mix(vec3(0.015, 0.022, 0.035), vec3(0.10, 0.13, 0.17), ds);
  // Submerged part (below the waterline) reads as under the sea: blend toward water.
  float submerge = clamp(-elev / -FOOT, 0.0, 1.0) * step(elev, 0.0);
  mountainColor = mix(mountainColor, color, submerge * 0.7);

  color = mix(color, mountainColor, mtnAlpha);

  // Night-vision mode: collapse to a dim red monochrome.
  float lum = dot(color, vec3(0.299, 0.587, 0.114));
  color = mix(color, vec3(lum * 0.55, lum * 0.06, lum * 0.04), uNight);

#ifdef ATMO
  color += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
#endif
  gl_FragColor = vec4(color, 1.0);
}
`;

/**
 * Camera-centred sky + sea sphere. It lives directly in the scene (NOT under skyRoot): the
 * gradient and sea are symmetric about +Y, so calibration yaw is irrelevant to them. The one
 * yaw-sensitive item, the sun direction, is supplied in skyRoot-local space via setSun() and
 * rotated into world space by the caller-supplied skyRoot quaternion in update().
 */
export class DomeSky {
  constructor(scene) {
    this.scene = scene;
    this.waveTime = 0;
    this._sunLocal = new THREE.Vector3(0, -1, 0);
    this._sunWorld = new THREE.Vector3(0, -1, 0);
    this._wantVisible = true;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uSunDir: { value: new THREE.Vector3(0, -1, 0) },
        uTime: { value: 0 },
        uNight: { value: 0 }
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      toneMapped: false
    });
    this.geometry = new THREE.SphereGeometry(DOME_RADIUS, 32, 16);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /**
   * Switch the sky to takram's physical atmosphere (sea reflections and mountains keep working; they
   * read skyColor()). Rebuilds the material as GLSL3 with the Bruneton runtime prepended.
   * @param {import('./atmosphere.js').Atmosphere} atmo
   */
  enableAtmosphere(atmo) {
    this.atmosphere = atmo;
    const old = this.material;
    const defines = { ...ATMOSPHERE_DEFINES };
    if (atmo.uniforms.higher_order_scattering_texture.value) defines.HAS_HIGHER_ORDER_SCATTERING_TEXTURE = '1';
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      defines,
      uniforms: { ...old.uniforms, ...atmo.uniforms },
      vertexShader: SKY_VERT,
      fragmentShader: ATMOSPHERE_GLSL + SKY_FRAG,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
      toneMapped: false
    });
    this.mesh.material = this.material;
    old.dispose();
  }

  /** Sun direction in skyRoot-local space (same frame as star positions). */
  setSun(dir) {
    this._sunLocal.set(dir.x, dir.y, dir.z).normalize();
    this.sunAltDeg = Math.asin(THREE.MathUtils.clamp(this._sunLocal.y, -1, 1)) * THREE.MathUtils.RAD2DEG;
  }

  /**
   * @param {number} dt seconds
   * @param {THREE.Vector3} [cameraWorldPos] dome follows this
   * @param {THREE.Quaternion} [skyRootQuat] skyRoot world rotation (calibration yaw)
   */
  update(dt, cameraWorldPos, skyRootQuat) {
    this.waveTime += dt;
    this.material.uniforms.uTime.value = this.waveTime;
    if (cameraWorldPos) this.mesh.position.copy(cameraWorldPos);
    this._sunWorld.copy(this._sunLocal);
    if (skyRootQuat) this._sunWorld.applyQuaternion(skyRootQuat);
    this.material.uniforms.uSunDir.value.copy(this._sunWorld);
    if (this.atmosphere) this.atmosphere.update(this._sunWorld, this.sunAltDeg ?? -30, dt);
  }

  setVisible(v) {
    this._wantVisible = !!v;
    this.mesh.visible = this._wantVisible;
  }

  setNightMode(enabled) {
    this.material.uniforms.uNight.value = enabled ? 1.0 : 0.0;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.atmosphere?.dispose();
  }
}
