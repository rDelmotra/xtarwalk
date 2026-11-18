import * as THREE from 'three';

let activeDevice = null;

export async function initSimulatorIfRequested() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('sim') && !params.has('demo')) return null;

  const { XRDevice, metaQuest3 } = await import('iwer');
  const device = new XRDevice(metaQuest3, {
    stereoEnabled: false,
    fovy: (72 * Math.PI) / 180
  });
  device.installRuntime({ forceInstall: true });
  device.primaryInputMode = 'hand';

  if (params.has('sim') && !params.has('demo')) {
    const { DevUI } = await import('@iwer/devui');
    device.installDevUI(DevUI);
  }

  activeDevice = device;
  window.__xrDevice = device;
  return {
    device,
    isDemo: params.has('demo')
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createCompositeRecorder(srcCanvas, width = 1280, height = 720) {
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  let caption = '';
  let alive = true;

  const drawFrame = () => {
    if (!alive) return;
    ctx.fillStyle = '#02040a';
    ctx.fillRect(0, 0, width, height);
    if (srcCanvas.width > 0 && srcCanvas.height > 0) {
      // Aspect-fit cover
      const sAspect = srcCanvas.width / srcCanvas.height;
      const dAspect = width / height;
      let dx = 0, dy = 0, dw = width, dh = height;
      if (sAspect > dAspect) {
        dw = height * sAspect;
        dx = (width - dw) / 2;
      } else {
        dh = width / sAspect;
        dy = (height - dh) / 2;
      }
      ctx.drawImage(srcCanvas, dx, dy, dw, dh);
    }

    // Subtle badge top-left
    ctx.save();
    ctx.fillStyle = 'rgba(6, 12, 26, 0.72)';
    ctx.strokeStyle = 'rgba(96, 165, 250, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(22, 18, 286, 36, 10);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#93c5fd';
    ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('XTARWALK  •  META QUEST 3 WebXR', 36, 36);

    if (caption) {
      ctx.font = '600 18px -apple-system, BlinkMacSystemFont, sans-serif';
      const tw = ctx.measureText(caption).width;
      const bw = Math.min(width - 80, tw + 44);
      const bx = (width - bw) / 2;
      const by = height - 62;
      ctx.fillStyle = 'rgba(6, 12, 26, 0.82)';
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, 40, 20);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#f1f5f9';
      ctx.textAlign = 'center';
      ctx.fillText(caption, width / 2, by + 20);
    }
    ctx.restore();

    requestAnimationFrame(drawFrame);
  };
  requestAnimationFrame(drawFrame);

  const stream = out.captureStream(30);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 8_000_000
  });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = () => {
      alive = false;
      resolve(new Blob(chunks, { type: mimeType }));
    };
  });

  return {
    start: () => recorder.start(250),
    stop: async () => {
      recorder.stop();
      return stopped;
    },
    setCaption: (t) => { caption = t; }
  };
}

function dlog(msg) {
  console.log('[DEMO]', msg);
  fetch('/__demo_log', { method: 'POST', body: String(msg) }).catch(() => {});
}

export async function runAutomatedVrDemo({ renderer, scene, skyScene, hudPanel, findTargetByName, startXR, state }) {
  const device = activeDevice;
  if (!device) return;
  window.addEventListener('error', (e) => dlog('WINERR: ' + (e.error?.stack || e.message)));
  window.addEventListener('unhandledrejection', (e) => dlog('REJ: ' + (e.reason?.stack || e.reason)));
  dlog('runAutomatedVrDemo started');

  // Light up 3D WebXR hand meshes cleanly (sky shaders are unlit)
  if (scene) {
    scene.add(new THREE.HemisphereLight(0xa5d8ff, 0x1e293b, 1.8));
    const dl = new THREE.DirectionalLight(0xffffff, 1.1);
    dl.position.set(1, 2, 1);
    scene.add(dl);
  }

  while (!skyScene || skyScene.clickableMeshes.length === 0) {
    await sleep(100);
  }
  dlog('skyScene ready');
  await sleep(600);

  // Enter immersive-vr on emulated Meta Quest 3 first so canvas is at steady VR size
  dlog('calling startXR(immersive-vr)');
  await startXR('immersive-vr');
  dlog('startXR resolved');
  await sleep(800);

  const remote = device.remote;
  dlog('setting input mode hand');
  await remote.dispatch('set_input_mode', { mode: 'hand' });
  dlog('input mode hand set');
  await remote.dispatch('set_transform', {
    device: 'hand-left',
    position: { x: -0.26, y: 1.15, z: -0.45 }
  });
  await remote.dispatch('set_transform', {
    device: 'hand-right',
    position: { x: 0.26, y: 1.15, z: -0.45 }
  });

  const rec = createCompositeRecorder(renderer.domElement, 1280, 720);
  rec.setCaption('Xtarwalk XR — Real-Time Sky Planetarium (WebXR)');
  rec.start();

  const skyTargetWorld = (name) => {
    const t = findTargetByName(name);
    if (!t) return null;
    const v = new THREE.Vector3(t.pos.x, t.pos.y, t.pos.z);
    skyScene.skyRoot.updateMatrixWorld(true);
    return v.applyMatrix4(skyScene.skyRoot.matrixWorld);
  };

  const lookHeadsetAt = async (worldVec, duration = 1.5) => {
    const dir = worldVec.clone().normalize();
    const yawRad = Math.atan2(-dir.x, -dir.z);
    const pitchRad = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    await remote.dispatch('animate_to', {
      device: 'headset',
      orientation: {
        pitch: (pitchRad * 180) / Math.PI,
        yaw: (yawRad * 180) / Math.PI,
        roll: 0
      },
      duration,
      easing: 'minimum-jerk'
    });
  };

  const aimRightHandAt = async (worldTarget, duration = 0.65) => {
    const hs = await remote.dispatch('get_transform', { device: 'headset' });
    const hq = new THREE.Quaternion(hs.orientation.x, hs.orientation.y, hs.orientation.z, hs.orientation.w);
    const hp = new THREE.Vector3(hs.position.x, hs.position.y, hs.position.z);

    const handOffset = new THREE.Vector3(0.22, -0.24, -0.42).applyQuaternion(hq).add(hp);
    const dir = worldTarget.clone().sub(handOffset).normalize();
    const rayQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);

    await remote.dispatch('animate_to', {
      device: 'hand-right',
      position: { x: handOffset.x, y: handOffset.y, z: handOffset.z },
      orientation: { x: rayQuat.x, y: rayQuat.y, z: rayQuat.z, w: rayQuat.w },
      duration,
      easing: 'minimum-jerk'
    });
  };

  const pinchRight = async (holdSec = 0.16) => {
    await remote.dispatch('select', { device: 'hand-right', duration: holdSec });
  };

  try {
    // 1. Pan across the live night sky
    dlog('step 1: pan sky');
    const moonPos = skyTargetWorld('Moon') || new THREE.Vector3(-40, 42, 22);
    const saturnPos = skyTargetWorld('Saturn') || new THREE.Vector3(-25, 62, 30);
    await lookHeadsetAt(saturnPos.clone().lerp(moonPos, 0.35), 2.0);
    await sleep(900);

    // 2. Point & pinch Saturn -> 3D Spatial Info Card
    dlog('step 2: pinch Saturn');
    rec.setCaption('Hands-First Selection — Point & Pinch Saturn to Inspect');
    await lookHeadsetAt(saturnPos, 1.1);
    await aimRightHandAt(saturnPos, 0.8);
    await pinchRight(0.18);
    await sleep(2400);

    // 3. Point & pinch Moon -> Live Lunar Phase
    dlog('step 3: pinch Moon');
    rec.setCaption('Live Ephemeris — Point & Pinch Moon for Illumination & Phase');
    await lookHeadsetAt(moonPos, 1.3);
    await aimRightHandAt(moonPos, 0.8);
    await pinchRight(0.18);
    await sleep(2300);

    // 4. Spatial HUD "Find" -> 3D Wayfinder Arrow
    dlog('step 4: HUD Find');
    rec.setCaption('Spatial HUD — Pinch "Find" for Guided 3D Wayfinding');
    await remote.dispatch('animate_to', {
      device: 'headset',
      orientation: { pitch: 10, yaw: 145, roll: 0 },
      duration: 1.2,
      easing: 'minimum-jerk'
    });
    await sleep(300);

    const findBtn = hudPanel.buttonMeshes.find((m) => m.userData.hudAction === 'find');
    if (findBtn) {
      const p = new THREE.Vector3();
      findBtn.getWorldPosition(p);
      await aimRightHandAt(p, 0.7);
      await pinchRight(0.16);
      await sleep(900);

      const rowPick = hudPanel.rowMeshes.find((m) => m.userData.hudAction?.startsWith('findpick:'));
      if (rowPick) {
        rowPick.getWorldPosition(p);
        await aimRightHandAt(p, 0.7);
        await pinchRight(0.16);
        await sleep(600);

        const targetName = rowPick.userData.hudAction.slice(9);
        const tPos = skyTargetWorld(targetName);
        if (tPos) {
          const off = tPos.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.75);
          await lookHeadsetAt(off, 1.0);
          await sleep(1400);
          await lookHeadsetAt(tPos, 1.3);
          await sleep(2700);
        }
      }
      if (state && state.finding !== 'idle') {
        hudPanel.trigger('find');
      }
    }

    // 5. Agamotto Time-Travel Dial (Pinch + Twist Wrist)
    dlog('step 5: Time travel twist');
    rec.setCaption('Pinch + Twist Wrist — Time Travel with Live Star Trails');
    await lookHeadsetAt(new THREE.Vector3(0, 0.45, -1).normalize().multiplyScalar(50), 1.2);
    const hs = await remote.dispatch('get_transform', { device: 'headset' });
    const hq = new THREE.Quaternion(hs.orientation.x, hs.orientation.y, hs.orientation.z, hs.orientation.w);
    const hp = new THREE.Vector3(hs.position.x, hs.position.y, hs.position.z);
    const handSpot = new THREE.Vector3(0.22, -0.18, -0.45).applyQuaternion(hq).add(hp);
    const baseRollQuat = hq.clone();
    await remote.dispatch('animate_to', {
      device: 'hand-right',
      position: { x: handSpot.x, y: handSpot.y, z: handSpot.z },
      orientation: { x: baseRollQuat.x, y: baseRollQuat.y, z: baseRollQuat.z, w: baseRollQuat.w },
      duration: 0.6
    });
    await remote.dispatch('set_select_value', { device: 'hand-right', value: 1.0, duration: 0.1 });
    await sleep(250);
    const roll1 = baseRollQuat.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), 1.8));
    await remote.dispatch('animate_to', {
      device: 'hand-right',
      orientation: { x: roll1.x, y: roll1.y, z: roll1.z, w: roll1.w },
      duration: 2.0,
      easing: 'minimum-jerk'
    });
    const roll2 = baseRollQuat.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), 3.4));
    await remote.dispatch('animate_to', {
      device: 'hand-right',
      orientation: { x: roll2.x, y: roll2.y, z: roll2.z, w: roll2.w },
      duration: 2.0,
      easing: 'minimum-jerk'
    });
    await sleep(400);
    await remote.dispatch('set_select_value', { device: 'hand-right', value: 0.0, duration: 0.1 });
    await sleep(800);

    // 6. Astronomer Night Mode
    dlog('step 6: Night mode');
    rec.setCaption('Night Vision Mode — Red-Shifted Sky & Spatial UI');
    const nightBtn = hudPanel.buttonMeshes.find((m) => m.userData.hudAction === 'night');
    if (nightBtn) {
      const p = new THREE.Vector3();
      nightBtn.getWorldPosition(p);
      await aimRightHandAt(p, 0.7);
      await pinchRight(0.16);
      await sleep(2200);
      nightBtn.getWorldPosition(p);
      await aimRightHandAt(p, 0.5);
      await pinchRight(0.16);
    }

    // Back to Live
    const liveBtn = hudPanel.buttonMeshes.find((m) => m.userData.hudAction === 'timeNow');
    if (liveBtn) {
      const p = new THREE.Vector3();
      liveBtn.getWorldPosition(p);
      await aimRightHandAt(p, 0.6);
      await pinchRight(0.16);
    }

    rec.setCaption('Xtarwalk XR — Live in Meta Quest Browser (WebXR)');
    await lookHeadsetAt(saturnPos.clone().lerp(moonPos, 0.5), 1.6);
    await sleep(1600);
  } catch (err) {
    dlog('ERROR: ' + (err?.stack || err?.message || String(err)));
  } finally {
    dlog('stopping recorder and saving');
    const blob = await rec.stop();
    dlog('blob size=' + blob.size);
    await fetch('/__save_demo', {
      method: 'POST',
      body: blob
    });
    dlog('saved /__save_demo');
    window.__demoSaved = true;
  }
}
