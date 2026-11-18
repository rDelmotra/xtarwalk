import * as THREE from 'three';

export function makeTextSprite(text, {
  fontSize = 26,
  color = '#bae6fd',
  bgColor = 'rgba(8, 15, 30, 0.55)',
  borderColor = 'rgba(96, 165, 250, 0.35)',
  scale = 2.4
} = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const padX = 16;
  const padY = 10;
  canvas.width = Math.ceil(metrics.width + padX * 2);
  canvas.height = fontSize + padY * 2;

  ctx.font = font;
  ctx.fillStyle = bgColor;
  roundRect(ctx, 1, 1, canvas.width - 2, canvas.height - 2, 10);
  ctx.fill();

  if (borderColor) {
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, padX, canvas.height / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(scale * aspect, scale, 1);
  return sprite;
}

export class SpatialInfoCard {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 640;
    this.canvas.height = 280;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    const geo = new THREE.PlaneGeometry(0.68, 0.30);
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.visible = false;
    this.mesh.renderOrder = 20;
  }

  show(target, nightMode = false) {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = nightMode ? 'rgba(28, 6, 6, 0.90)' : 'rgba(10, 18, 36, 0.90)';
    roundRect(ctx, 6, 6, width - 12, height - 12, 22);
    ctx.fill();
    ctx.strokeStyle = nightMode ? '#ef4444' : '#60a5fa';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.fillStyle = nightMode ? '#fca5a5' : '#93c5fd';
    ctx.font = 'bold 42px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(target.name, 34, 68);

    ctx.fillStyle = nightMode ? '#f87171' : '#cbd5e1';
    ctx.font = '600 26px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(target.subtitle || '', 34, 112);

    ctx.fillStyle = nightMode ? '#fecaca' : '#e2e8f0';
    ctx.font = '500 26px -apple-system, BlinkMacSystemFont, sans-serif';
    const altAz = `Alt ${target.alt.toFixed(1)}°  •  Az ${target.az.toFixed(1)}°`;
    ctx.fillText(altAz, 34, 170);

    const line4 = target.extra
      ? target.extra
      : target.mag !== undefined
        ? `Visual Magnitude: ${target.mag.toFixed(2)}`
        : '';
    ctx.fillText(line4, 34, 214);

    if (target.distAu) {
      ctx.fillStyle = nightMode ? '#f87171' : '#94a3b8';
      ctx.font = '500 22px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillText(`Distance: ${target.distAu.toFixed(3)} AU`, 34, 250);
    }

    this.texture.needsUpdate = true;
    this.mesh.visible = true;
  }

  hide() {
    this.mesh.visible = false;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
