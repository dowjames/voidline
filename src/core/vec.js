// Minimal allocation-free vec3/quat helpers over plain {x,y,z} objects.
// Every function writes into an explicit output object; nothing allocates.

export function v3(x = 0, y = 0, z = 0) { return { x, y, z }; }

export function set(o, x, y, z) { o.x = x; o.y = y; o.z = z; return o; }
export function copy(o, a) { o.x = a.x; o.y = a.y; o.z = a.z; return o; }
export function add(o, a, b) { o.x = a.x + b.x; o.y = a.y + b.y; o.z = a.z + b.z; return o; }
export function sub(o, a, b) { o.x = a.x - b.x; o.y = a.y - b.y; o.z = a.z - b.z; return o; }
export function scale(o, a, s) { o.x = a.x * s; o.y = a.y * s; o.z = a.z * s; return o; }
export function addScaled(o, a, s) { o.x += a.x * s; o.y += a.y * s; o.z += a.z * s; return o; }
export function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function cross(o, a, b) {
  const ax = a.x, ay = a.y, az = a.z, bx = b.x, by = b.y, bz = b.z;
  o.x = ay * bz - az * by; o.y = az * bx - ax * bz; o.z = ax * by - ay * bx;
  return o;
}
export function len(a) { return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z); }
export function len2(a) { return a.x * a.x + a.y * a.y + a.z * a.z; }
export function dist(a, b) { const x = a.x - b.x, y = a.y - b.y, z = a.z - b.z; return Math.sqrt(x * x + y * y + z * z); }
export function dist2(a, b) { const x = a.x - b.x, y = a.y - b.y, z = a.z - b.z; return x * x + y * y + z * z; }
export function normalize(o, a) {
  const l = a.x * a.x + a.y * a.y + a.z * a.z;
  if (l > 1e-12) { const s = 1 / Math.sqrt(l); o.x = a.x * s; o.y = a.y * s; o.z = a.z * s; }
  else { o.x = 0; o.y = 0; o.z = 0; }
  return o;
}
export function lerp(o, a, b, t) { o.x = a.x + (b.x - a.x) * t; o.y = a.y + (b.y - a.y) * t; o.z = a.z + (b.z - a.z) * t; return o; }
export function clampLen(o, a, max) {
  const l2 = a.x * a.x + a.y * a.y + a.z * a.z;
  if (l2 > max * max) { const s = max / Math.sqrt(l2); o.x = a.x * s; o.y = a.y * s; o.z = a.z * s; return true; }
  o.x = a.x; o.y = a.y; o.z = a.z; return false;
}

// ---- quaternion {x,y,z,w} ----
export function q4(x = 0, y = 0, z = 0, w = 1) { return { x, y, z, w }; }
export function qIdent(o) { o.x = 0; o.y = 0; o.z = 0; o.w = 1; return o; }
export function qCopy(o, a) { o.x = a.x; o.y = a.y; o.z = a.z; o.w = a.w; return o; }
export function qMul(o, a, b) {
  const ax = a.x, ay = a.y, az = a.z, aw = a.w;
  const bx = b.x, by = b.y, bz = b.z, bw = b.w;
  o.x = ax * bw + aw * bx + ay * bz - az * by;
  o.y = ay * bw + aw * by + az * bx - ax * bz;
  o.z = az * bw + aw * bz + ax * by - ay * bx;
  o.w = aw * bw - ax * bx - ay * by - az * bz;
  return o;
}
export function qNormalize(o, a) {
  const l = a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w;
  if (l > 1e-12) { const s = 1 / Math.sqrt(l); o.x = a.x * s; o.y = a.y * s; o.z = a.z * s; o.w = a.w * s; }
  else qIdent(o);
  return o;
}
export function qFromAxisAngle(o, ax, ay, az, ang) {
  const h = ang * 0.5, s = Math.sin(h), c = Math.cos(h);
  o.x = ax * s; o.y = ay * s; o.z = az * s; o.w = c;
  return o;
}
// rotate v by q -> o
export function qRotateVec(o, q, v) {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const vx = v.x, vy = v.y, vz = v.z;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  o.x = vx + qw * tx + (qy * tz - qz * ty);
  o.y = vy + qw * ty + (qz * tx - qx * tz);
  o.z = vz + qw * tz + (qx * ty - qy * tx);
  return o;
}
// shortest-arc quaternion from a to b
export function qFromTo(o, a, b) {
  const d = dot(a, b);
  if (d > 0.999999) return qIdent(o);
  if (d < -0.999999) {
    // pick any perpendicular axis
    let px = 1, py = 0, pz = 0;
    if (Math.abs(a.x) > 0.9) { px = 0; py = 1; pz = 0; }
    cross(o, a, set(TMP_A, px, py, pz));
    normalize(o, o);
    o.w = 0;
    return o;
  }
  const cx = a.y * b.z - a.z * b.y;
  const cy = a.z * b.x - a.x * b.z;
  const cz = a.x * b.y - a.y * b.x;
  o.x = cx; o.y = cy; o.z = cz; o.w = 1 + d;
  return qNormalize(o, o);
}
// slerp (angular) for smooth camera work
export function qSlerp(o, a, b, t) {
  let ax = a.x, ay = a.y, az = a.z, aw = a.w;
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  let cosHalf = ax * bx + ay * by + az * bz + aw * bw;
  if (cosHalf < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; cosHalf = -cosHalf; }
  if (cosHalf >= 0.9995) {
    o.x = ax + (bx - ax) * t; o.y = ay + (by - ay) * t; o.z = az + (bz - az) * t; o.w = aw + (bw - aw) * t;
    return qNormalize(o, o);
  }
  const half = Math.acos(cosHalf), s = Math.sin(half);
  const wa = Math.sin((1 - t) * half) / s, wb = Math.sin(t * half) / s;
  o.x = ax * wa + bx * wb; o.y = ay * wa + by * wb; o.z = az * wa + bz * wb; o.w = aw * wa + bw * wb;
  return o;
}
// build an orientation looking down `dir` with `up` hint
const TMP_A = v3();
export function qLookAt(o, dir, upx, upy, upz) {
  let fx = dir.x, fy = dir.y, fz = dir.z;
  const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  // right = up x forward
  let rx = upy * fz - upz * fy, ry = upz * fx - upx * fz, rz = upx * fy - upy * fx;
  let rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (rl < 1e-6) { rx = 1; ry = 0; rz = 0; rl = 1; }
  rx /= rl; ry /= rl; rz /= rl;
  // true up = forward x right
  const ux = fy * rz - fz * ry, uy = fz * rx - fx * rz, uz = fx * ry - fy * rx;
  // rotation matrix columns: right, up, -forward (three.js convention: object looks down -Z)
  const m0 = rx, m1 = ux, m2 = -fx;
  const m3 = ry, m4 = uy, m5 = -fy;
  const m6 = rz, m7 = uz, m8 = -fz;
  const trace = m0 + m4 + m8;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    o.w = 0.25 / s;
    o.x = (m7 - m5) * s;
    o.y = (m2 - m6) * s;
    o.z = (m3 - m1) * s;
  } else if (m0 > m4 && m0 > m8) {
    const s = 2.0 * Math.sqrt(1.0 + m0 - m4 - m8);
    o.w = (m7 - m5) / s;
    o.x = 0.25 * s;
    o.y = (m1 + m3) / s;
    o.z = (m2 + m6) / s;
  } else if (m4 > m8) {
    const s = 2.0 * Math.sqrt(1.0 + m4 - m0 - m8);
    o.w = (m2 - m6) / s;
    o.x = (m1 + m3) / s;
    o.y = 0.25 * s;
    o.z = (m5 + m7) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m8 - m0 - m4);
    o.w = (m3 - m1) / s;
    o.x = (m2 + m6) / s;
    o.y = (m5 + m7) / s;
    o.z = 0.25 * s;
  }
  return qNormalize(o, o);
}
// inverse (conjugate) of a unit quaternion
export function qInv(o, a) { o.x = -a.x; o.y = -a.y; o.z = -a.z; o.w = a.w; return o; }
