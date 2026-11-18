import * as THREE from 'three';
import { SKY_RADIUS, altAzToVec3 } from '../astro/skyEngine.js';

// Ported from orbitwatch HorizonLayer.ts: 8-point compass of billboard letter sprites.
const CARDINAL_NORTH = '#ff6b4a';
const CARDINAL_OTHER = '#8fe3ff';
const CARDINAL_MINOR = '#6aa6c2';

const MARKERS = [
  { letter: 'N', az: 0, major: true },
  { letter: 'NE', az: 45, major: false },
  { letter: 'E', az: 90, major: true },
  { letter: 'SE', az: 135, major: false },
  { letter: 'S', az: 180, major: true },
  { letter: 'SW', az: 225, major: false },
  { letter: 'W', az: 270, major: true },
  { letter: 'NW', az: 315, major: false }
];

const MAJOR_SCALE = 4.4;
const MINOR_SCALE = MAJOR_SCALE * 0.66;

function makeLabelSprite(letter, color, major) {
  const h = 64;
  const w = letter.length > 1 ? 112 : 64;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = color;
  ctx.font = `bold ${major ? 44 : 32}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 6;
  ctx.fillText(letter, w / 2, h / 2 + 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: major ? 1 : 0.72,
    depthTest: true,
    depthWrite: false
  });
  const sprite = new THREE.Sprite(material);
  const scale = major ? MAJOR_SCALE : MINOR_SCALE;
  sprite.scale.set(scale * (w / h), scale, 1);
  sprite.renderOrder = 2;
  return sprite;
}

export class Compass {
  /** @param {THREE.Object3D} parent usually skyRoot, so calibration yaw rotates it */
  constructor(parent) {
    this.parent = parent;
    this.group = new THREE.Group();
    this.sprites = MARKERS.map((m) => {
      const color = m.letter === 'N' ? CARDINAL_NORTH : m.major ? CARDINAL_OTHER : CARDINAL_MINOR;
      const s = makeLabelSprite(m.letter, color, m.major);
      const p = altAzToVec3(2, m.az, SKY_RADIUS * 0.9);
      s.position.set(p.x, p.y, p.z);
      s.userData.baseOpacity = m.major ? 1 : 0.72;
      this.group.add(s);
      return s;
    });
    parent.add(this.group);
  }

  setNightMode(enabled) {
    for (const s of this.sprites) s.material.color.setHex(enabled ? 0xff6666 : 0xffffff);
  }

  setVisible(v) {
    this.group.visible = !!v;
  }

  dispose() {
    this.parent.remove(this.group);
    for (const s of this.sprites) {
      s.material.map?.dispose();
      s.material.dispose();
    }
    this.sprites = [];
  }
}
