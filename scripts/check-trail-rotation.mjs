// Verifies the GLSL Rodrigues rotation used in starTrails.js matches THREE.Quaternion.setFromAxisAngle.
import * as THREE from 'three';
const rodrigues = (v, k, a) => {
  const c = Math.cos(a), s = Math.sin(a), d = k.dot(v);
  return v.clone().multiplyScalar(c).add(new THREE.Vector3().crossVectors(k, v).multiplyScalar(s)).add(k.clone().multiplyScalar(d * (1 - c)));
};
let worst = 0;
for (const k of [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0.3, 0.8, -0.5).normalize(), new THREE.Vector3(0, 1, 0)])
  for (const v of [new THREE.Vector3(80, 0, 0), new THREE.Vector3(10, 70, -30), new THREE.Vector3(-5, 2, 79)])
    for (const a of [0, 0.4, -1.3, 3.0, -6.1]) {
      const q = new THREE.Quaternion().setFromAxisAngle(k, a);
      worst = Math.max(worst, rodrigues(v, k, a).distanceTo(v.clone().applyQuaternion(q)));
    }
console.log('max deviation', worst);
if (worst > 1e-9) { console.error('FAIL'); process.exit(1); }
console.log('OK');
