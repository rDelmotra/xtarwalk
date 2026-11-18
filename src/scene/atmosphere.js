import * as THREE from 'three';
import {
  AtmosphereParameters,
  PrecomputedTexturesLoader,
  getSunLightColor,
  METER_TO_LENGTH_UNIT,
  TRANSMITTANCE_TEXTURE_WIDTH,
  TRANSMITTANCE_TEXTURE_HEIGHT,
  SCATTERING_TEXTURE_R_SIZE,
  SCATTERING_TEXTURE_MU_SIZE,
  SCATTERING_TEXTURE_MU_S_SIZE,
  SCATTERING_TEXTURE_NU_SIZE,
  IRRADIANCE_TEXTURE_WIDTH,
  IRRADIANCE_TEXTURE_HEIGHT
} from '@takram/three-atmosphere';
import { common, definitions, runtime } from '@takram/three-atmosphere/shaders/bruneton';

/**
 * takram's physically based sky (Bruneton precomputed scattering), the same tables orbitwatch's ground
 * mode uses, packaged so an ordinary mesh shader can call it. That matters for XR: orbitwatch draws its
 * sky as a full-screen post effect, which WebXR's per-eye rendering cannot run; here the dome sphere
 * evaluates the sky per fragment, so each eye gets its own correct ray.
 *
 * The tables (~10 MB of EXR) are self-hosted in public/atmosphere/ (copied from the npm package).
 * Until they load, or if they never do, the dome keeps its analytic gradient.
 */
const ATMO = AtmosphereParameters.DEFAULT;

/** Eye height above the sea, metres (a little above the water so the horizon is crisp). */
const EYE_HEIGHT_M = 2;

/**
 * orbitwatch's ground exposure law (camera/exposure.ts EXPOSURE_BY_LIGHT_GROUND), keyed on the sun's
 * altitude, interpolated in log space. The deep-night end is held lower than orbitwatch's photographic
 * 12000: a star app wants a near-black night sky, not a long-exposure blue one.
 */
const EXPOSURE_BY_SUN_ALT = [
  [-18, 2500],
  [-15, 2200],
  [-12, 1700],
  [-9, 900],
  [-6, 320],
  [-3, 100],
  [0, 30],
  [5, 10],
  [15, 4],
  [30, 2.5],
  [60, 2]
];

export function exposureForSunAlt(altDeg) {
  const t = EXPOSURE_BY_SUN_ALT;
  if (altDeg <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (altDeg <= t[i][0]) {
      const [a0, e0] = t[i - 1];
      const [a1, e1] = t[i];
      const f = (altDeg - a0) / (a1 - a0);
      return Math.exp(Math.log(e0) + f * (Math.log(e1) - Math.log(e0)));
    }
  }
  return t[t.length - 1][1];
}

/** Daylight white balance: divides out the sun's top-of-atmosphere colour (orbitwatch whiteBalance, k = 1). */
function whiteBalance() {
  const s = ATMO.solarIrradiance;
  const l = ATMO.sunRadianceToRelativeLuminance;
  const c = [s.x * l.x, s.y * l.y, s.z * l.z];
  const m = (c[0] + c[1] + c[2]) / 3;
  return new THREE.Vector3(m / c[0], m / c[1], m / c[2]);
}

/** GLSL prepended to a GLSL3 ShaderMaterial fragment shader: takram's Bruneton runtime + its uniforms. */
export const ATMOSPHERE_GLSL = /* glsl */ `
precision highp sampler3D;
layout(location = 0) out highp vec4 xwFragColor;
#define gl_FragColor xwFragColor
${definitions}
uniform AtmosphereParameters ATMOSPHERE;
uniform vec3 SUN_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform vec3 SKY_SPECTRAL_RADIANCE_TO_LUMINANCE;
uniform sampler2D transmittance_texture;
uniform sampler3D scattering_texture;
uniform sampler2D irradiance_texture;
uniform sampler3D single_mie_scattering_texture;
uniform sampler3D higher_order_scattering_texture;
${common}
${runtime}
`;

export const ATMOSPHERE_DEFINES = {
  ATMO: '1',
  PI: `${Math.PI}`,
  TRANSMITTANCE_TEXTURE_WIDTH: TRANSMITTANCE_TEXTURE_WIDTH.toFixed(0),
  TRANSMITTANCE_TEXTURE_HEIGHT: TRANSMITTANCE_TEXTURE_HEIGHT.toFixed(0),
  SCATTERING_TEXTURE_R_SIZE: SCATTERING_TEXTURE_R_SIZE.toFixed(0),
  SCATTERING_TEXTURE_MU_SIZE: SCATTERING_TEXTURE_MU_SIZE.toFixed(0),
  SCATTERING_TEXTURE_MU_S_SIZE: SCATTERING_TEXTURE_MU_S_SIZE.toFixed(0),
  SCATTERING_TEXTURE_NU_SIZE: SCATTERING_TEXTURE_NU_SIZE.toFixed(0),
  IRRADIANCE_TEXTURE_WIDTH: IRRADIANCE_TEXTURE_WIDTH.toFixed(0),
  IRRADIANCE_TEXTURE_HEIGHT: IRRADIANCE_TEXTURE_HEIGHT.toFixed(0),
  METER_TO_LENGTH_UNIT: METER_TO_LENGTH_UNIT.toFixed(7),
  COMBINED_SCATTERING_TEXTURES: '1'
};

export class Atmosphere {
  constructor(textures) {
    this.textures = textures;
    // Observer at the top of +Y on a spherical Earth: scene directions are already "ECEF" directions.
    const rKm = (ATMO.bottomRadius + EYE_HEIGHT_M) * METER_TO_LENGTH_UNIT;
    this._camWorld = new THREE.Vector3(0, ATMO.bottomRadius + EYE_HEIGHT_M, 0); // metres, for the CPU helper
    this._sunColor = new THREE.Color();
    this.exposure = exposureForSunAlt(-30);
    this.uniforms = {
      ATMOSPHERE: ATMO.toUniform(),
      SUN_SPECTRAL_RADIANCE_TO_LUMINANCE: { value: ATMO.sunRadianceToRelativeLuminance },
      SKY_SPECTRAL_RADIANCE_TO_LUMINANCE: { value: ATMO.skyRadianceToRelativeLuminance },
      transmittance_texture: { value: textures.transmittanceTexture },
      scattering_texture: { value: textures.scatteringTexture },
      irradiance_texture: { value: textures.irradianceTexture },
      single_mie_scattering_texture: { value: textures.singleMieScatteringTexture ?? null },
      higher_order_scattering_texture: { value: textures.higherOrderScatteringTexture ?? null },
      uAtmoCam: { value: new THREE.Vector3(0, rKm, 0) },
      uExposure: { value: this.exposure },
      uWhiteBalance: { value: whiteBalance() },
      uSunTint: { value: new THREE.Vector3(1, 1, 1) }, // sunlight colour after the air, normalised
      uSunVisible: { value: 0 }
    };
  }

  /** Loads the self-hosted tables. Resolves to null on failure (the caller keeps its fallback sky). */
  static async load(renderer) {
    try {
      const loader = new PrecomputedTexturesLoader();
      loader.setType(renderer);
      const base = `${import.meta.env.BASE_URL}atmosphere`;
      const textures = await new Promise((resolve, reject) => loader.load(base, resolve, undefined, reject));
      return new Atmosphere(textures);
    } catch (err) {
      console.warn('[atmosphere] tables failed to load, keeping the gradient sky', err);
      return null;
    }
  }

  /**
   * @param {THREE.Vector3} sunWorld unit vector toward the Sun, scene/world frame (+Y up)
   * @param {number} sunAltDeg
   * @param {number} dt seconds (exposure eases like a camera, faster when time is being scrubbed)
   */
  update(sunWorld, sunAltDeg, dt) {
    const target = exposureForSunAlt(sunAltDeg);
    if (!this._eased) { this.exposure = target; this._eased = true; } // first frame: no fade-in from night
    // ease in log space; ~0.25 s time constant (fast enough to follow the time dial)
    const k = 1 - Math.exp(-dt / 0.25);
    this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(target) - Math.log(this.exposure)) * k);
    this.uniforms.uExposure.value = this.exposure;

    getSunLightColor(this.textures.transmittanceTexture, this._camWorld, sunWorld, this._sunColor, { correctAltitude: false });
    const c = this._sunColor;
    const m = Math.max(c.r, c.g, c.b, 1e-6);
    const wb = this.uniforms.uWhiteBalance.value;
    const tint = this.uniforms.uSunTint.value.set((c.r / m) * wb.x, (c.g / m) * wb.y, (c.b / m) * wb.z);
    tint.divideScalar(Math.max(tint.x, tint.y, tint.z, 1e-6));
    this.uniforms.uSunVisible.value = THREE.MathUtils.smoothstep(sunAltDeg, -1.2, 0.6);
  }

  dispose() {
    for (const t of Object.values(this.textures)) t?.dispose?.();
  }
}
