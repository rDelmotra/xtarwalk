import * as THREE from 'three';

const BUTTON_DEFS = [
  { id: 'calibrate', label: 'Snap to Sky', w: 0.22, icon: 'target' },
  { id: 'find', label: 'Find', w: 0.14, icon: 'search' },
  { id: 'timeNow', label: 'Live', w: 0.14, icon: 'clock', accent: 'amber' },
  { id: 'constellations', label: 'Lines', w: 0.15, icon: 'lines' },
  { id: 'night', label: 'Night', w: 0.15, icon: 'moon' }
];
const BUTTONS = (() => {
  const gap = 0.018;
  const total = BUTTON_DEFS.reduce((s, d) => s + d.w, 0) + gap * (BUTTON_DEFS.length - 1);
  let x = -total / 2;
  return BUTTON_DEFS.map((d) => {
    const b = { ...d, x, y: 0, h: 0.08 };
    x += d.w + gap;
    return b;
  });
})();

const PALETTES = {
  day: {
    fill: 'rgba(14, 22, 40, 0.88)', fillActive: 'rgba(40, 110, 130, 0.55)',
    line: 'rgba(160, 205, 230, 0.35)', lineActive: '#8fe3f5',
    text: '#dbe7f3', textActive: '#d6f8ff', amber: '#8fe3f5', panel: 0x070c18, hint: '#7f93a8'
  },
  night: {
    fill: 'rgba(28, 6, 6, 0.9)', fillActive: 'rgba(130, 24, 18, 0.6)',
    line: 'rgba(190, 50, 40, 0.45)', lineActive: '#e0503f',
    text: '#d46a5c', textActive: '#ff9080', amber: '#d8402e', panel: 0x140303, hint: '#8a3a32'
  }
};

export class SpatialHudPanel {
  constructor(onAction) {
    this.onAction = onAction;
    this.group = new THREE.Group();
    this.buttonMeshes = [];
    this.night = false;
    this.rowItems = [];

    const bgGeo = new THREE.PlaneGeometry(1.04, 0.32);
    const bgMat = new THREE.MeshBasicMaterial({
      map: makePanelTexture(PALETTES.day),
      transparent: true,
      side: THREE.DoubleSide
    });
    this.bg = new THREE.Mesh(bgGeo, bgMat);
    this.bg.position.y = -0.08;
    this.group.add(this.bg);

    this.hint = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.03),
      new THREE.MeshBasicMaterial({ map: makeHintTexture('Pinch + twist to turn time', PALETTES.day.hint), transparent: true })
    );
    this.hint.position.set(0, -0.172, 0.005);
    this.group.add(this.hint);

    this.rowMeshes = [];
    this.setRow([{ id: 'resetAlign', label: 'Reset alignment' }]);

    this.active = {};
    for (const b of BUTTONS) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(b.w, b.h),
        new THREE.MeshBasicMaterial({ map: makeButtonTexture(b.label, false, b.icon, b.accent, PALETTES.day), transparent: true })
      );
      mesh.position.set(b.x + b.w / 2, 0, 0.005);
      mesh.userData.hudAction = b.id;
      mesh.userData.label = b.label;
      mesh.userData.icon = b.icon;
      mesh.userData.accent = b.accent;
      this.group.add(mesh);
      this.buttonMeshes.push(mesh);
    }

    this.group.visible = false;
  }

  _pal() {
    return this.night ? PALETTES.night : PALETTES.day;
  }

  _retex(mesh, active) {
    mesh.material.map.dispose();
    mesh.material.map = makeButtonTexture(mesh.userData.label, active, mesh.userData.icon, mesh.userData.accent, this._pal());
    mesh.material.needsUpdate = true;
  }

  setButtonActive(id, active) {
    this.active[id] = active;
    const mesh = this.buttonMeshes.find((m) => m.userData.hudAction === id);
    if (!mesh) return;
    this._retex(mesh, active);
    mesh.userData.active = active;
    if (id === 'night' && active !== this.night) this._setNight(active);
  }

  _setNight(night) {
    this.night = night;
    const pal = this._pal();
    this.bg.material.map.dispose();
    this.bg.material.map = makePanelTexture(pal);
    this.bg.material.needsUpdate = true;
    this.hint.material.map.dispose();
    this.hint.material.map = makeHintTexture('Pinch + twist to turn time', pal.hint);
    this.hint.material.needsUpdate = true;
    for (const m of this.buttonMeshes) this._retex(m, !!m.userData.active);
  }

  /**
   * Second HUD row (below the main buttons): reference choices / Cancel / Reset alignment.
   * @param {{id: string, label: string, active?: boolean}[]} items
   */
  setRow(items) {
    for (const m of this.rowMeshes) {
      this.group.remove(m);
      this.buttonMeshes.splice(this.buttonMeshes.indexOf(m), 1);
      m.material.map.dispose();
      m.material.dispose();
      m.geometry.dispose();
    }
    this.rowMeshes = [];
    const n = items.length;
    const gap = 0.008;
    const w = Math.min(0.2, (0.96 - gap * (n - 1)) / Math.max(1, n));
    const total = w * n + gap * (n - 1);
    items.forEach((it, i) => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, 0.08),
        new THREE.MeshBasicMaterial({ map: makeButtonTexture(it.label, !!it.active, null, null, this._pal()), transparent: true })
      );
      mesh.position.set(-total / 2 + w / 2 + i * (w + gap), -0.1, 0.005);
      mesh.userData.hudAction = it.id;
      mesh.userData.label = it.label;
      mesh.userData.active = !!it.active;
      this.group.add(mesh);
      this.buttonMeshes.push(mesh);
      this.rowMeshes.push(mesh);
    });
  }

  trigger(id) {
    this.onAction(id);
  }
}

// ---------- canvas drawing ----------

function drawIcon(ctx, kind, cx, cy, s, color) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (kind) {
    case 'target':
      ctx.arc(0, 0, s * 0.55, 0, Math.PI * 2);
      ctx.moveTo(0, -s); ctx.lineTo(0, -s * 0.55);
      ctx.moveTo(0, s); ctx.lineTo(0, s * 0.55);
      ctx.moveTo(-s, 0); ctx.lineTo(-s * 0.55, 0);
      ctx.moveTo(s, 0); ctx.lineTo(s * 0.55, 0);
      ctx.stroke();
      break;
    case 'search':
      ctx.arc(-s * 0.15, -s * 0.15, s * 0.6, 0, Math.PI * 2);
      ctx.moveTo(s * 0.3, s * 0.3); ctx.lineTo(s * 0.95, s * 0.95);
      ctx.stroke();
      break;
    case 'clock':
      ctx.arc(0, 0, s * 0.9, 0, Math.PI * 2);
      ctx.moveTo(0, -s * 0.5); ctx.lineTo(0, 0); ctx.lineTo(s * 0.4, s * 0.3);
      ctx.stroke();
      break;
    case 'lines': {
      const pts = [[-0.9, 0.7], [-0.3, -0.2], [0.3, 0.3], [0.9, -0.7]];
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * s, y * s) : ctx.moveTo(x * s, y * s)));
      ctx.stroke();
      for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x * s, y * s, 4.5, 0, Math.PI * 2); ctx.fill(); }
      break;
    }
    case 'moon':
      ctx.arc(0, 0, s * 0.9, 0.55 * Math.PI, 1.9 * Math.PI, false);
      ctx.arc(s * 0.35, -s * 0.2, s * 0.75, 1.85 * Math.PI - 0.25, 0.7 * Math.PI, true);
      ctx.stroke();
      break;
  }
  ctx.restore();
}

function makePanelTexture(pal) {
  const c = document.createElement('canvas');
  c.width = 1040; c.height = 320;
  const ctx = c.getContext('2d');
  ctx.fillStyle = pal === PALETTES.night ? 'rgba(20, 3, 3, 0.8)' : 'rgba(7, 12, 24, 0.78)';
  ctx.beginPath();
  ctx.roundRect(4, 4, 1032, 312, 48);
  ctx.fill();
  ctx.strokeStyle = pal.line;
  ctx.lineWidth = 3;
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeHintTexture(text, color) {
  const c = document.createElement('canvas');
  c.width = 600; c.height = 30;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.font = '500 20px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.letterSpacing = '3px';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.toUpperCase(), 300, 16);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeButtonTexture(label, active, icon, accent, pal) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 96;
  const ctx = c.getContext('2d');
  const amber = accent === 'amber';
  ctx.fillStyle = active ? pal.fillActive : pal.fill;
  ctx.beginPath();
  ctx.roundRect(4, 4, 248, 88, 44);
  ctx.fill();
  ctx.strokeStyle = active ? pal.lineActive : amber ? pal.amber : pal.line;
  ctx.globalAlpha = active || amber ? 0.9 : 1;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.globalAlpha = 1;

  const fg = amber ? pal.amber : active ? pal.textActive : pal.text;
  const iconW = icon ? 56 : 0;
  ctx.fillStyle = fg;
  let fontPx = 34;
  do {
    ctx.font = `600 ${fontPx}px -apple-system, BlinkMacSystemFont, sans-serif`;
    fontPx -= 2;
  } while (ctx.measureText(label).width > 208 - iconW && fontPx > 14);
  const tw = ctx.measureText(label).width;
  const startX = 128 - (tw + iconW) / 2;
  if (icon) drawIcon(ctx, icon, startX + 18, 48, 17, fg);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, startX + iconW, 50);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
