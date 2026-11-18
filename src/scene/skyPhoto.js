import * as THREE from 'three';
import * as Astronomy from 'astronomy-engine';

/**
 * SIMULATED passthrough for demo footage: a real photograph of the whole sky (ESO/S. Brunier, "The Milky Way
 * panorama", eso0932a, CC BY 4.0, galactic coordinates) wrapped on a sphere and rotated to the observer's sky at
 * the shown time, so the app's overlay lands on the photo's real stars. Camera grain, lifted blacks and a dark
 * ground make it read like night passthrough. It is NOT what a Quest passthrough camera actually sees at night.
 */
// J2000 equatorial -> galactic rotation (rows: galactic x, y, z in equatorial components)
const EQ_TO_GAL = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [0.4941094279, -0.444829630, 0.7469822445],
  [-0.867666149, -0.1980763734, 0.4559837762]
];

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform mat3 uLocalToGal;
uniform float uTime;
uniform float uGain;
varying vec3 vDir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime * 37.0) * 43758.5453); }
float ridge(float az) { return 0.012 + 0.018 * (0.5 + 0.5 * sin(az * 5.0 + sin(az * 13.0) * 0.8)) * (0.6 + 0.4 * sin(az * 23.0)); }
void main() {
  vec3 d = normalize(vDir);
  vec3 g = uLocalToGal * d;
  float l = atan(g.y, g.x);                  // galactic longitude, 0 at the centre
  float b = asin(clamp(g.z, -1.0, 1.0));
  vec2 uv = vec2(0.5 - l / 6.2831853, 0.5 + b / 3.1415927);
  vec3 c = texture2D(uMap, uv).rgb;
  c = pow(c, vec3(1.15)) * uGain;            // a little darker than the long-exposure photo
  float lum = dot(c, vec3(0.3, 0.59, 0.11));
  c = mix(vec3(lum), c, 0.55);               // passthrough cameras are low-saturation at night
  c += vec3(0.022, 0.026, 0.034);            // lifted, slightly cool blacks
  // dark foreground: the ground and a low tree/hill line, so the sky is not floating
  float az = atan(d.x, -d.z);
  float top = ridge(az);
  float ground = smoothstep(top + 0.004, top - 0.004, d.y);
  c = mix(c, vec3(0.018, 0.02, 0.024), ground);
  c += (hash(gl_FragCoord.xy) - 0.5) * 0.05; // sensor grain
  gl_FragColor = vec4(c, 1.0);
}`;

export class SkyPhoto {
  constructor(parent) {
    this.parent = parent;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: null }, uLocalToGal: { value: new THREE.Matrix3() }, uTime: { value: 0 }, uGain: { value: 0.75 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(150, 64, 32), this.material);
    this.mesh.renderOrder = -1001;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  async load(url = `${import.meta.env.BASE_URL}textures/sky-eso0932a-4k.jpg`) {
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.colorSpace = THREE.NoColorSpace; // the shader writes display values directly, like the rest of the sky
    tex.anisotropy = 4;
    this.material.uniforms.uMap.value = tex;
  }

  setVisible(v) { this.mesh.visible = !!v; }

  /** Rotate the photo to the sky over (lat, lon) at `date` (skyRoot-local frame: +X East, +Y up, -Z North). */
  update(date, lat, lon, dt = 0) {
    this.material.uniforms.uTime.value = (this.material.uniforms.uTime.value + dt) % 1000;
    const phi = lat * Math.PI / 180;
    const lst = ((Astronomy.SiderealTime(date) * 15 + lon) % 360) * Math.PI / 180;
    // equatorial axes expressed in the local frame
    const P = new THREE.Vector3(0, Math.sin(phi), -Math.cos(phi));    // celestial pole
    const Q0 = new THREE.Vector3(0, Math.cos(phi), Math.sin(phi));    // equator on the meridian (hour angle 0)
    const W = new THREE.Vector3(-1, 0, 0);                            // equator at hour angle 6h (west)
    const X = Q0.clone().multiplyScalar(Math.cos(lst)).addScaledVector(W, Math.sin(lst)); // RA 0h
    const Y = Q0.clone().multiplyScalar(Math.sin(lst)).addScaledVector(W, -Math.cos(lst)); // RA 6h
    // local -> equatorial: rows are the equatorial axes; then -> galactic
    const toEq = new THREE.Matrix3().set(X.x, X.y, X.z, Y.x, Y.y, Y.z, P.x, P.y, P.z);
    const G = EQ_TO_GAL;
    const toGal = new THREE.Matrix3().set(G[0][0], G[0][1], G[0][2], G[1][0], G[1][1], G[1][2], G[2][0], G[2][1], G[2][2]);
    this.material.uniforms.uLocalToGal.value.multiplyMatrices(toGal, toEq);
  }

  dispose() {
    this.parent.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.material.uniforms.uMap.value?.dispose();
  }
}
