// Chase camera: spring-damped follow with impulse shake and speed-driven FOV.

import * as THREE from 'three';

const _off = new THREE.Vector3();
const _look = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _tmp = new THREE.Vector3();

export function createCameraRig(camera, opts = {}) {
  const baseFov = opts.fov ?? 68;
  const offset = new THREE.Vector3(0, 2.9, 13.5);
  const lookAhead = opts.lookAhead ?? 26;
  const posStiff = opts.posStiff ?? 7.5;
  const rotStiff = opts.rotStiff ?? 9.0;
  let shake = 0;
  let roll = 0;

  camera.fov = baseFov;
  camera.near = 0.5;
  camera.far = 2.2e7;
  camera.updateProjectionMatrix();

  return {
    camera,
    addShake(v) { shake = Math.min(2.4, shake + v); },
    update(player, dt, opts2 = {}) {
      const q = new THREE.Quaternion(player.quat.x, player.quat.y, player.quat.z, player.quat.w);

      // desired eye position trails the craft and drifts back with speed
      const spd = Math.hypot(player.vel.x, player.vel.y, player.vel.z);
      const back = 1 + Math.min(0.55, spd / 900);
      _off.copy(offset).multiplyScalar(back);
      _off.applyQuaternion(q);
      const target = _tmp.set(player.pos.x + _off.x, player.pos.y + _off.y, player.pos.z + _off.z);

      const kp = 1 - Math.exp(-posStiff * dt);
      camera.position.lerp(target, kp);

      // orientation: slerp the craft's rotation, then bias the look point forward
      _q.copy(q);
      const kr = 1 - Math.exp(-rotStiff * dt);
      camera.quaternion.slerp(_q, kr);

      // shake: high-frequency positional + rotational jitter
      if (shake > 0.0005) {
        const s = shake;
        camera.position.x += (Math.random() - 0.5) * s * 0.85;
        camera.position.y += (Math.random() - 0.5) * s * 0.85;
        camera.position.z += (Math.random() - 0.5) * s * 0.85;
        const j = new THREE.Quaternion().setFromEuler(new THREE.Euler(
          (Math.random() - 0.5) * s * 0.035,
          (Math.random() - 0.5) * s * 0.035,
          (Math.random() - 0.5) * s * 0.02));
        camera.quaternion.multiply(j);
        shake *= Math.max(0, 1 - dt * 4.2);
      } else {
        shake = 0;
      }

      // FOV widens with velocity -> sense of speed without moving the craft
      const targetFov = baseFov + Math.min(16, spd * 0.021) + (opts2.throttleKick || 0) * 3.2;
      camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-3.4 * dt));
      camera.updateProjectionMatrix();

      // look slightly ahead of the craft so it sits low-centre in frame
      _look.set(0, 0, -lookAhead).applyQuaternion(q).add(player.pos);
      return _look;
    },
    get shake() { return shake; },
  };
}
