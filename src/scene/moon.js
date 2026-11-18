import * as THREE from 'three';

/**
 * A realistic Moon: a sphere lit by the real Sun direction (so the phase and the tilt of the terminator are
 * physically right), with a procedural near side — the maria that make the familiar "face", fine regolith
 * noise, the bright Tycho/Copernicus ray craters — faint earthshine on the dark part, and a soft glow.
 * The mesh is turned to face the observer every update so the same near side is always shown.
 */
const VERT = /* glsl */ `
  varying vec3 vObjN;   // object-space normal (fixed lunar surface coordinates; +Z faces the observer)
  varying vec3 vWorldN;
  varying vec3 vWorldP;
  void main() {
    vObjN = normalize(position);
    vWorldP = (modelMatrix * vec4(position, 1.0)).xyz;
    vWorldN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uSunWorld;
  uniform float uNight;
  uniform float uOpacity;
  uniform float uDay;     // 0 night .. 1 daylight (moon washes out a little in daylight)
  uniform sampler2D uMap; // NASA LROC colour map (decoded to linear by the sampler)
  uniform float uHasMap;  // 0 until the texture has loaded (procedural fallback), then 1
  varying vec3 vObjN;
  varying vec3 vWorldN;
  varying vec3 vWorldP;

  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
  // soft elliptical blob on the near-side disc (x right, y up as seen from Earth)
  float mare(vec2 q, vec2 c, vec2 r) { vec2 d = (q - c) / r; return 1.0 - smoothstep(0.15, 1.25, length(d)); }

  float proceduralAlbedo(vec3 n) {
    vec2 q = n.xy;                      // orthographic near-side coordinates
    float warp = fbm(n * 3.0) - 0.5;
    vec2 qw = q + 0.11 * vec2(warp, fbm(n * 3.0 + 7.1) - 0.5);
    // the main maria of the near side (approximate layout of the "man in the moon")
    float m = 0.0;
    m = max(m, mare(qw, vec2(-0.30, 0.42), vec2(0.30, 0.22)));  // Imbrium
    m = max(m, mare(qw, vec2(-0.55, 0.05), vec2(0.30, 0.48)));  // Oceanus Procellarum
    m = max(m, mare(qw, vec2( 0.13, 0.40), vec2(0.17, 0.15)));  // Serenitatis
    m = max(m, mare(qw, vec2( 0.38, 0.16), vec2(0.22, 0.16)));  // Tranquillitatis
    m = max(m, mare(qw, vec2( 0.68, 0.28), vec2(0.11, 0.10)));  // Crisium
    m = max(m, mare(qw, vec2( 0.58,-0.12), vec2(0.13, 0.17)));  // Fecunditatis
    m = max(m, mare(qw, vec2( 0.28,-0.18), vec2(0.13, 0.12)));  // Nectaris
    m = max(m, mare(qw, vec2(-0.18,-0.28), vec2(0.20, 0.13)));  // Nubium
    m = max(m, mare(qw, vec2(-0.50,-0.45), vec2(0.12, 0.10)));  // Humorum
    m = max(m, mare(qw, vec2( 0.05, 0.72), vec2(0.35, 0.07)));  // Frigoris
    m = clamp(m * (0.55 + 0.7 * fbm(n * 4.5)), 0.0, 1.0);

    float highland = 0.62 + 0.22 * fbm(n * 9.0) + 0.08 * fbm(n * 40.0);
    float albedo = mix(highland, 0.40 + 0.08 * fbm(n * 14.0), m * 0.85);
    // bright young ray craters: Tycho (south) and Copernicus
    vec2 tycho = q - vec2(-0.10, -0.68);
    float tR = length(tycho);
    float rays = pow(max(0.0, sin(atan(tycho.y, tycho.x) * 9.0 + fbm(n * 5.0) * 9.0)), 12.0) * smoothstep(0.6, 0.05, tR) * fbm(n * 20.0);
    albedo += 0.18 * smoothstep(0.035, 0.0, tR) + 0.06 * rays;
    albedo += 0.10 * smoothstep(0.03, 0.0, length(q - vec2(-0.30, 0.17)));
    // small crater pits
    float pits = smoothstep(0.8, 0.95, noise(n * 70.0)) * 0.05;
    albedo -= pits;
    return albedo;
  }

  void main() {
    vec3 n = normalize(vObjN);
    float albedo;
    vec3 base;
    float relief = 0.0;
    if (uHasMap > 0.5) {
      // selenographic lon/lat -> equirectangular uv (lon 0 at image centre, east right, north up)
      float lon = atan(n.x, n.z);
      float lat = asin(clamp(n.y, -1.0, 1.0));
      vec2 uv = vec2(0.5 + lon / 6.28318530718, 0.5 + lat / 3.14159265359);
      vec3 tex = texture2D(uMap, uv).rgb;               // linear
      float tl = dot(tex, vec3(0.2126, 0.7152, 0.0722));
      // the map is pale and slightly blue-grey: pull toward warm grey, then add contrast so maria read small
      vec3 c = mix(vec3(tl), tex, 0.55) * vec3(1.04, 1.0, 0.94);
      c = pow(max(c, vec3(0.0)), vec3(1.35)) * 1.25;
      base = c;
      relief = tl - 0.45;
    } else {
      albedo = proceduralAlbedo(n);
      base = vec3(1.0, 0.975, 0.93) * albedo;
      base = pow(base, vec3(2.2));
    }

    vec3 L = normalize(uSunWorld);
    vec3 N = normalize(vWorldN);
    vec3 V = normalize(cameraPosition - vWorldP);
    float mu0 = dot(N, L);
    float mu = max(dot(N, V), 0.03);
    // Lommel-Seeliger: L ~ mu0 / (mu0 + mu) -- almost no limb darkening; normalised so disc centre at full moon = 1
    float m0 = max(mu0, 0.0);
    float ls = 2.0 * m0 / (m0 + mu);
    float term = smoothstep(-0.02, 0.10, mu0);
    // low sun makes albedo/relief contrast stronger near the terminator
    float grazing = 1.0 - smoothstep(0.0, 0.35, m0);
    float lit = term * ls * (1.0 + 0.9 * grazing * relief);
    float earthshine = 0.03;
    vec3 col = base * (lit * 1.0 + earthshine * (1.0 - term));
    col *= mix(1.0, 0.85, uDay);
    col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));   // back to display values, as the rest of the sky is
    float l = dot(col, vec3(0.3, 0.59, 0.11));
    col = mix(col, vec3(1.0, 0.25, 0.2) * l, uNight);
    gl_FragColor = vec4(col, uOpacity);
  }
`;

const GLOW_FRAG = /* glsl */ `
  uniform float uStrength;
  uniform float uNight;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float r = length(vUv - 0.5) * 2.0;
    float g = uOpacity * uStrength * (0.55 * exp(-r * 5.5) + 0.12 * exp(-r * 2.2)) * smoothstep(1.0, 0.7, r);
    vec3 c = mix(vec3(0.85, 0.9, 1.0), vec3(1.0, 0.25, 0.2), uNight);
    vec3 finalCol = c * g;
    float a = clamp(max(finalCol.r, max(finalCol.g, finalCol.b)), 0.0, 1.0);
    if (a < 0.002) discard;
    gl_FragColor = vec4(finalCol, a);
  }
`;
const GLOW_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

export class Moon {
  constructor(radius = 1.0) {
    this.radius = radius;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uSunWorld: { value: new THREE.Vector3(0, 1, 0) }, uNight: { value: 0 }, uDay: { value: 0 }, uMap: { value: null }, uHasMap: { value: 0 }, uOpacity: { value: 1 } },
      transparent: true,
      vertexShader: VERT,
      fragmentShader: FRAG
    });
    this.glowMaterial = new THREE.ShaderMaterial({
      uniforms: { uStrength: { value: 0.5 }, uNight: { value: 0 }, uOpacity: { value: 1 } },
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor
    });
    this._disposed = false;
    this.map = null;
    new THREE.TextureLoader().load(
      import.meta.env.BASE_URL + 'textures/moon-lroc-2k.jpg',
      (tex) => {
        if (this._disposed) { tex.dispose(); return; }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        this.map = tex;
        this.material.uniforms.uMap.value = tex;
        this.material.uniforms.uHasMap.value = 1;
      },
      undefined,
      () => { /* keep the procedural fallback */ }
    );
    this.geometry = new THREE.SphereGeometry(radius, 48, 32);
    this.glowGeometry = new THREE.PlaneGeometry(radius * 9, radius * 9);
  }

  /** A new mesh (+glow child) for one snapshot build; shares geometry/material (mark: keepGpu). */
  makeMesh() {
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.userData.keepGpu = true;
    mesh.renderOrder = 2;
    const glow = new THREE.Mesh(this.glowGeometry, this.glowMaterial);
    glow.userData.keepGpu = true;
    glow.renderOrder = 1;
    mesh.add(glow);
    mesh.userData.glow = glow;
    return mesh;
  }

  /** Face the observer (origin of skyRoot) so the near side shows; billboard the glow. */
  orient(mesh) {
    mesh.lookAt(0, 0, 0); // for non-camera objects lookAt turns local +Z toward the target
  }

  /** @param sunWorld world-space unit vector toward the Sun; @param phaseFrac 0..1 illuminated */
  update(sunWorld, phaseFrac, dayFade, night) {
    this.material.uniforms.uSunWorld.value.copy(sunWorld);
    this.material.uniforms.uNight.value = night ? 1 : 0;
    this.material.uniforms.uDay.value = 1 - dayFade;
    this.glowMaterial.uniforms.uStrength.value = (0.15 + 0.85 * phaseFrac) * (0.35 + 0.65 * dayFade);
    this.glowMaterial.uniforms.uNight.value = night ? 1 : 0;
  }

  /** 1 = the full virtual Moon; lower in MR so the real one shows through (0 = only the crosshair/label). */
  setOpacity(a) {
    this.material.uniforms.uOpacity.value = a;
    this.glowMaterial.uniforms.uOpacity.value = a;
  }

  dispose() {
    this._disposed = true;
    if (this.map) this.map.dispose();
    this.material.dispose();
    this.glowMaterial.dispose();
    this.geometry.dispose();
    this.glowGeometry.dispose();
  }
}
