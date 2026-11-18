import * as THREE from 'three';

/**
 * Desktop/phone sky-pointing aids (Star Walk style, in the app's instrument theme):
 *  - a faint aim reticle fixed at the centre of the screen,
 *  - a name pill at the bottom naming whatever is under the reticle (click it to select),
 *  - an edge chevron that points toward the selected object when it is off-screen.
 * XR has its own wayfinder, so this hides itself while in XR.
 */
const UPDATE_MS = 180;

export class AimReticle {
  constructor({ onSelect }) {
    this.onSelect = onSelect;
    this.root = document.createElement('div');
    this.root.className = 'aim-layer';
    this.root.innerHTML = `
      <svg class="aim-reticle" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="22" />
        <circle cx="32" cy="32" r="9" />
        <circle cx="32" cy="32" r="1.4" class="dot" />
      </svg>
      <button class="aim-name" type="button"></button>
      <div class="aim-arrow" aria-hidden="true">
        <svg viewBox="0 0 40 40"><path d="M6 30 L20 8 L34 30 L20 22 Z" /></svg>
        <span></span>
      </div>`;
    document.body.appendChild(this.root);
    this.nameBtn = this.root.querySelector('.aim-name');
    this.arrow = this.root.querySelector('.aim-arrow');
    this.arrowLabel = this.arrow.querySelector('span');
    this.current = null;
    this.lastPick = 0;
    this._fwd = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this.nameBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.nameBtn.addEventListener('pointerup', (e) => e.stopPropagation());
    this.nameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.current) this.onSelect?.(this.current);
    });
  }

  /** World position of a selection target (stars live in the rotating celestial group). */
  worldPos(skyScene, t, out) {
    out.set(t.pos.x, t.pos.y, t.pos.z);
    return (t.kind === 'planet' || t.kind === 'satellite') ? skyScene.skyRoot.localToWorld(out) : skyScene.celestialGroup.localToWorld(out);
  }

  update(now, camera, skyScene, selected, { visible = true, pickExtra = null } = {}) {
    this.root.classList.toggle('hidden', !visible);
    if (!visible || !skyScene) return;

    // 1) what is under the reticle (throttled)
    if (now - this.lastPick > UPDATE_MS) {
      this.lastPick = now;
      camera.getWorldDirection(this._fwd);
      let pick = null;
      const ray = new THREE.Raycaster(camera.position, this._fwd);
      const hits = ray.intersectObjects(skyScene.planetGroup.children, false);
      if (hits.length) pick = hits[0].object.userData.target;
      if (!pick && pickExtra) pick = pickExtra(this._fwd, Math.min(camera.fov, 40));
      if (!pick) pick = skyScene.pickStar(this._fwd, Math.min(camera.fov, 40));
      if (pick && pick.alt < -1 && skyScene.clipHorizon) pick = null;
      this.current = pick;
      this.nameBtn.textContent = pick ? pick.name : '';
      this.nameBtn.classList.toggle('show', !!pick);
    }

    // 2) edge chevron toward an off-screen selection
    if (!selected || !selected.pos) { this.arrow.classList.remove('show'); return; }
    const p = this.worldPos(skyScene, selected, this._v);
    p.project(camera); // NDC; z > 1 => behind the camera
    const behind = p.z > 1;
    let x = p.x, y = p.y;
    if (behind) { x = -x; y = -y; }
    const onScreen = !behind && Math.abs(x) < 0.92 && Math.abs(y) < 0.9;
    if (onScreen) { this.arrow.classList.remove('show'); return; }
    const W = window.innerWidth, H = window.innerHeight;
    const ang = Math.atan2(-y * H, x * W); // screen-space angle (y down)
    // put the chevron on an inset ellipse around the screen centre
    const rx = W / 2 - 46, ry = H / 2 - 56;
    const cx = W / 2 + Math.cos(ang) * rx;
    const cy = H / 2 + Math.sin(ang) * ry;
    this.arrow.style.transform = `translate(${cx.toFixed(1)}px, ${cy.toFixed(1)}px)`;
    this.arrow.querySelector('svg').style.transform = `rotate(${(ang * 180 / Math.PI + 90).toFixed(1)}deg)`;
    this.arrowLabel.textContent = selected.name;
    this.arrow.classList.add('show');
  }
}
