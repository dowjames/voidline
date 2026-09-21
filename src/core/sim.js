// Deterministic fixed-timestep space combat simulation.
// NO DOM, NO three.js, NO wall clock, NO Math.random. Runs identically in Node and the browser.
//
// Scale: metres, seconds. Player fighter ~18 m hull. Combat arena ~3.5 km across,
// an earth-like planet whose surface sits PLANET_ALT metres below the arena origin.

import { makeRng } from './rng.js';
import { createFx, FX_EXPLOSION, FX_IMPACT, FX_MUZZLE, FX_SHIELD_HIT } from './fx.js';
import * as V from './vec.js';

export const DT = 1 / 60;

export const PLANET_RADIUS = 6371000;
export const PLANET_ALT = 4200;            // arena origin altitude above sea level
export const PLANET_SURFACE_Y = -PLANET_RADIUS - PLANET_ALT;

// --- player flight model -----------------------------------------------------
const P_RADIUS = 9;
const THRUST_ACCEL = 62;                  // m/s^2 at full throttle
const MAX_SPEED = 780;
const ANG_ACCEL = 5.2;                    // rad/s^2 RCS authority
const MAX_ANG_VEL = 2.4;                  // rad/s
const DAMP_RATE = 4.6;                    // reaction-wheel damping when dampeners on
const SHIELD_REGEN = 6.5;                 // hp/s after a delay
const SHIELD_REGEN_DELAY = 4.0;
const HULL_REGEN = 0.9;

// --- weapons ---------------------------------------------------------------
const FIRE_INTERVAL = 0.085;              // s between cannon shots
const BULLET_SPEED = 1450;                // m/s muzzle velocity (added to ship velocity)
const BULLET_LIFE = 2.9;
const BULLET_RADIUS = 0.55;
const BULLET_DAMAGE = 9;
const HEAT_PER_SHOT = 0.038;
const HEAT_COOL = 0.24;
const OVERHEAT_LOCK = 0.98;

// --- enemies ---------------------------------------------------------------
const E_RADIUS = 8;
const E_ACCEL = 41;
const E_MAX_ANG = 1.9;
const E_FIRE_INTERVAL = 1.15;
const E_BULLET_SPEED = 780;
const E_BULLET_DAMAGE = 5.5;

const ARENA_RADIUS = 1750;
const SPAWN_SHELL = [820, 1500];

const KIND_PLAYER = 0;
const KIND_ENEMY = 1;

// ---------------------------------------------------------------------------

function makePlayer() {
  return {
    alive: true,
    pos: V.v3(0, 0, 0), vel: V.v3(0, 0, 0), quat: V.q4(0, 0, 0, 1), angVel: V.v3(0, 0, 0),
    throttle: 0, rcsP: 0, rcsY: 0, rcsR: 0, dampeners: true,
    health: 100, maxHealth: 100, shield: 100, maxShield: 100,
    radius: P_RADIUS, heat: 0, overheated: false, fireCd: 0, lastHit: -99,
    hits: 0, distance: 0,
  };
}

function makeEnemy(i) {
  return {
    alive: false, idx: i, kind: 0,
    pos: V.v3(), vel: V.v3(), quat: V.q4(0, 0, 0, 1), angVel: V.v3(),
    health: 0, maxHealth: 1, radius: E_RADIUS,
    fireCd: 0, phase: 0, orbit: 0, aggro: 0, spawnGrace: 0,
  };
}

function makeBullet() {
  return {
    alive: false, owner: KIND_ENEMY, kind: 0,
    pos: V.v3(), vel: V.v3(), life: 0, maxLife: BULLET_LIFE, damage: 1, radius: BULLET_RADIUS,
  };
}

function makeAsteroid() {
  return {
    alive: false, idx: 0,
    pos: V.v3(), vel: V.v3(), quat: V.q4(0, 0, 0, 1), angVel: V.v3(),
    radius: 30, health: 100, maxHealth: 100, seedIdx: 0,
  };
}

// --- spatial hash broadphase (allocation-free per query) ---------------------
const CELL = 220;
const HASH_SIZE = 4096;
const hashHead = new Int32Array(HASH_SIZE);
const hashNext = new Int32Array(4096);

function hashKey(ix, iy, iz) {
  return ((ix * 92837111) ^ (iy * 689287499) ^ (iz * 283923481)) & (HASH_SIZE - 1);
}

// ---------------------------------------------------------------------------

export function createWorld(seed = 'arena', opts = {}) {
  const cfg = {
    maxEnemies: opts.enemies ?? 24,
    maxBullets: opts.bullets ?? 320,
    maxParticles: opts.particles ?? 2400,
    maxAsteroids: opts.asteroids ?? 6,
  };
  const rng = makeRng(seed);
  const world = {
    seed, frame: 0, time: 0, cfg,
    rng,
    fx: createFx(),
    player: makePlayer(),
    enemies: new Array(cfg.maxEnemies),
    bullets: new Array(cfg.maxBullets),
    asteroids: new Array(cfg.maxAsteroids),
    // Particles are structure-of-arrays: bulk data, zero per-frame allocation.
    particles: {
      cap: cfg.maxParticles, count: 0, head: 0,
      px: new Float32Array(cfg.maxParticles), py: new Float32Array(cfg.maxParticles), pz: new Float32Array(cfg.maxParticles),
      vx: new Float32Array(cfg.maxParticles), vy: new Float32Array(cfg.maxParticles), vz: new Float32Array(cfg.maxParticles),
      life: new Float32Array(cfg.maxParticles), maxLife: new Float32Array(cfg.maxParticles),
      size: new Float32Array(cfg.maxParticles),
      r: new Float32Array(cfg.maxParticles), g: new Float32Array(cfg.maxParticles), b: new Float32Array(cfg.maxParticles),
      kind: new Uint8Array(cfg.maxParticles),
    },
    stats: { enemiesAlive: 0, bulletsAlive: 0, particlesAlive: 0, shotsFired: 0, hits: 0, kills: 0, spawned: 0 },
    events: { playerHit: 0, shake: 0 },
  };
  for (let i = 0; i < cfg.maxEnemies; i++) world.enemies[i] = makeEnemy(i);
  for (let i = 0; i < cfg.maxBullets; i++) world.bullets[i] = makeBullet();
  for (let i = 0; i < cfg.maxAsteroids; i++) world.asteroids[i] = makeAsteroid(i);
  return world;
}

// --- particle spawn (ring buffer, oldest recycled) ---------------------------
function spawnParticle(w, x, y, z, vx, vy, vz, life, size, r, g, b, kind) {
  const p = w.particles;
  // ring buffer: capacity is arbitrary (not necessarily a power of two)
  let i;
  if (p.count < p.cap) { i = p.count++; }
  else { i = p.head; p.head = (p.head + 1) % p.cap; }
  p.px[i] = x; p.py[i] = y; p.pz[i] = z;
  p.vx[i] = vx; p.vy[i] = vy; p.vz[i] = vz;
  p.life[i] = life; p.maxLife[i] = life;
  p.size[i] = size; p.r[i] = r; p.g[i] = g; p.b[i] = b; p.kind[i] = kind;
}

// --- spawners --------------------------------------------------------------
function spawnEnemy(w, e) {
  const r = w.rng;
  const p = w.player.pos;
  const theta = r() * Math.PI * 2;
  const phi = Math.acos(1 - 2 * r());
  const rad = SPAWN_SHELL[0] + r() * (SPAWN_SHELL[1] - SPAWN_SHELL[0]);
  e.pos.x = p.x + rad * Math.sin(phi) * Math.cos(theta);
  e.pos.y = p.y + rad * Math.cos(phi) * 0.45;
  e.pos.z = p.z + rad * Math.sin(phi) * Math.sin(theta);
  const spd = 26 + r() * 42;
  e.vel.x = -Math.sin(phi) * Math.cos(theta) * spd;
  e.vel.y = -Math.cos(phi) * spd * 0.3;
  e.vel.z = -Math.sin(phi) * Math.sin(theta) * spd;
  V.qLookAt(e.quat, V.set(TMP1, p.x - e.pos.x, p.y - e.pos.y, p.z - e.pos.z), 0, 1, 0);
  e.angVel.x = 0; e.angVel.y = 0; e.angVel.z = 0;
  e.kind = r() < 0.3 ? 1 : 0;
  e.maxHealth = e.kind === 1 ? 150 : 90;
  e.health = e.maxHealth;
  e.radius = e.kind === 1 ? 10.5 : E_RADIUS;
  e.fireCd = 0.6 + r() * 2.2;
  e.phase = r() * Math.PI * 2;
  e.orbit = 180 + r() * 260;
  e.aggro = 0.5 + r() * 0.5;
  e.spawnGrace = 0.6;
  e.alive = true;
  w.stats.spawned++;
}

function spawnAsteroid(w, a) {
  const r = w.rng;
  const p = w.player.pos;
  const theta = r() * Math.PI * 2;
  const phi = Math.acos(1 - 2 * r());
  const rad = 1100 + r() * 900;
  a.pos.x = p.x + rad * Math.sin(phi) * Math.cos(theta);
  a.pos.y = p.y + rad * Math.cos(phi) * 0.35;
  a.pos.z = p.z + rad * Math.sin(phi) * Math.sin(theta);
  const spd = 8 + r() * 26;
  a.vel.x = -Math.sin(phi) * Math.cos(theta) * spd + r.gauss() * 4;
  a.vel.y = -Math.cos(phi) * spd * 0.25;
  a.vel.z = -Math.sin(phi) * Math.sin(theta) * spd + r.gauss() * 4;
  V.qFromAxisAngle(a.quat, r(), r(), r(), r() * 6.283);
  a.angVel.x = r.gauss() * 0.22;
  a.angVel.y = r.gauss() * 0.22;
  a.angVel.z = r.gauss() * 0.16;
  a.radius = 16 + r() * 78;
  a.maxHealth = 60 + a.radius * 6;
  a.health = a.maxHealth;
  a.seedIdx = r.int(0, 65535);
  a.alive = true;
  w.stats.spawned++;
}

function fireBullet(w, owner, ox, oy, oz, dx, dy, dz, speed, damage, life, kind) {
  const b = findFreeBullet(w);
  if (!b) return null;
  b.alive = true; b.owner = owner; b.kind = kind;
  b.pos.x = ox; b.pos.y = oy; b.pos.z = oz;
  b.vel.x = dx * speed; b.vel.y = dy * speed; b.vel.z = dz * speed;
  b.life = life; b.maxLife = life; b.damage = damage;
  w.stats.shotsFired++;
  return b;
}

let _bulletCursor = 0;
function findFreeBullet(w) {
  const arr = w.bullets, n = arr.length;
  for (let k = 0; k < n; k++) {
    const i = (_bulletCursor + k) % n;
    if (!arr[i].alive) { _bulletCursor = (i + 1) % n; return arr[i]; }
  }
  // pool saturated: recycle oldest-ish to keep the workload constant
  const i = _bulletCursor % n;
  _bulletCursor = (i + 1) % n;
  return arr[i];
}

// scratch (module-level, reused; sim is single-threaded and non-reentrant)
const TMP1 = V.v3(), TMP2 = V.v3(), TMP3 = V.v3(), TMP4 = V.v3();
const QS = V.q4();

// --- player ----------------------------------------------------------------
function updatePlayer(w, input) {
  const p = w.player;
  if (!p.alive) return;
  const dt = DT;

  p.throttle = input.throttle;
  p.rcsP = input.pitch; p.rcsY = input.yaw; p.rcsR = input.roll;
  p.dampeners = input.dampeners !== false;

  // RCS torque in BODY frame (pitch=X, yaw=Y, roll=Z)
  p.angVel.x += p.rcsP * ANG_ACCEL * dt;
  p.angVel.y += p.rcsY * ANG_ACCEL * dt;
  p.angVel.z += p.rcsR * ANG_ACCEL * dt;

  if (p.dampeners) {
    const d = Math.exp(-DAMP_RATE * dt);
    p.angVel.x *= d; p.angVel.y *= d; p.angVel.z *= d;
  }
  const av2 = p.angVel.x * p.angVel.x + p.angVel.y * p.angVel.y + p.angVel.z * p.angVel.z;
  if (av2 > MAX_ANG_VEL * MAX_ANG_VEL) {
    const s = MAX_ANG_VEL / Math.sqrt(av2);
    p.angVel.x *= s; p.angVel.y *= s; p.angVel.z *= s;
  }

  // integrate orientation: q' = 0.5 * q ⊗ (0, ω_body)
  const wx = p.angVel.x * dt * 0.5, wy = p.angVel.y * dt * 0.5, wz = p.angVel.z * dt * 0.5;
  const qx = p.quat.x, qy = p.quat.y, qz = p.quat.z, qw = p.quat.w;
  p.quat.x += (qx * 0 + qw * wx + qy * wz - qz * wy);
  p.quat.y += (qy * 0 + qw * wy + qz * wx - qx * wz);
  p.quat.z += (qz * 0 + qw * wz + qx * wy - qy * wx);
  p.quat.w += -(qx * wx + qy * wy + qz * wz);
  V.qNormalize(p.quat, p.quat);

  // main engine along body -Z
  const fwd = V.set(TMP1, 0, 0, -1);
  V.qRotateVec(TMP2, p.quat, fwd);
  const a = p.throttle * THRUST_ACCEL;
  p.vel.x += TMP2.x * a * dt;
  p.vel.y += TMP2.y * a * dt;
  p.vel.z += TMP2.z * a * dt;

  V.clampLen(TMP3, p.vel, MAX_SPEED);
  V.copy(p.vel, TMP3);

  p.pos.x += p.vel.x * dt; p.pos.y += p.vel.y * dt; p.pos.z += p.vel.z * dt;
  p.distance += len3(p.vel) * dt;

  // shields / hull
  if (w.time - p.lastHit > SHIELD_REGEN_DELAY) {
    p.shield = Math.min(p.maxShield, p.shield + SHIELD_REGEN * dt);
    if (p.health < p.maxHealth * 0.6) p.health = Math.min(p.maxHealth, p.health + HULL_REGEN * dt);
  }

  // weapon heat
  p.heat = Math.max(0, p.heat - HEAT_COOL * dt);
  if (p.overheated && p.heat < 0.55) p.overheated = false;
  p.fireCd -= dt;
  if (input.fire && !p.overheated && p.fireCd <= 0) {
    p.fireCd = FIRE_INTERVAL;
    p.heat = Math.min(1, p.heat + HEAT_PER_SHOT);
    if (p.heat >= OVERHEAT_LOCK) p.overheated = true;
    // twin cannon: two muzzles offset in body X
    const right = V.set(TMP3, 1, 0, 0);
    V.qRotateVec(TMP3, p.quat, right);
    const up = V.set(TMP4, 0, 1, 0);
    V.qRotateVec(TMP4, p.quat, up);
    for (let s = -1; s <= 1; s += 2) {
      const mx = p.pos.x + TMP3.x * s * 3.1 + TMP2.x * 7.5 + TMP4.y * 0.4;
      const my = p.pos.y + TMP3.y * s * 3.1 + TMP2.y * 7.5 + TMP4.y * 0.4;
      const mz = p.pos.z + TMP3.z * s * 3.1 + TMP2.z * 7.5 + TMP4.y * 0.4;
      const jitter = 0.0035;
      const dx = TMP2.x + w.rng.gauss() * jitter;
      const dy = TMP2.y + w.rng.gauss() * jitter;
      const dz = TMP2.z + w.rng.gauss() * jitter;
      fireBullet(w, KIND_PLAYER, mx, my, mz, dx, dy, dz,
        BULLET_SPEED + len3(p.vel), BULLET_DAMAGE, BULLET_LIFE, 0);
      w.fx.emit(FX_MUZZLE, mx, my, mz, TMP2.x, TMP2.y, TMP2.z, 1, s, 0, 0);
    }
  }
}

function len3(v) { return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }

// --- enemy AI --------------------------------------------------------------
function updateEnemy(w, e) {
  const p = w.player;
  const dt = DT;
  if (e.spawnGrace > 0) e.spawnGrace -= dt;

  // intercept solution: aim at where the player will be
  const dx = p.pos.x - e.pos.x, dy = p.pos.y - e.pos.y, dz = p.pos.z - e.pos.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;

  // desired standoff: close to orbit radius, strafe laterally
  const want = e.orbit;
  const radial = (d - want) / Math.max(want, 1);
  const closing = (dx * e.vel.x + dy * e.vel.y + dz * e.vel.z) / d;

  // strafe axis = perpendicular to line-of-sight, in the plane of the enemy's velocity
  const sx = -dz / d, sz = dx / d;
  const strafe = Math.sin(w.time * 0.55 + e.phase) * (e.kind === 1 ? 0.55 : 0.85);

  const tvx = (dx / d) * radial * E_ACCEL * 1.6 + sx * strafe * E_ACCEL * 0.8;
  const tvy = (dy / d) * radial * E_ACCEL * 1.2 + Math.cos(w.time * 0.4 + e.phase) * E_ACCEL * 0.18;
  const tvz = (dz / d) * radial * E_ACCEL * 1.6 + sz * strafe * E_ACCEL * 0.8;

  // steer velocity toward desired velocity
  e.vel.x += (tvx - e.vel.x * 0.35) * dt * e.aggro;
  e.vel.y += (tvy - e.vel.y * 0.35) * dt * e.aggro;
  e.vel.z += (tvz - e.vel.z * 0.35) * dt * e.aggro;
  V.clampLen(TMP1, e.vel, 190); V.copy(e.vel, TMP1);

  e.pos.x += e.vel.x * dt; e.pos.y += e.vel.y * dt; e.pos.z += e.vel.z * dt;

  // aim: rotate body -Z toward lead point with limited rate
  const aimx = p.pos.x - e.pos.x;
  const aimy = p.pos.y - e.pos.y;
  const aimz = p.pos.z - e.pos.z;
  V.set(TMP2, aimx, aimy, aimz);
  const targetQ = TMP3;
  V.qLookAt(targetQ, TMP2, 0, 1, 0);
  // slerp toward the target orientation, capped at the craft's max angular rate
  const cosHalf = Math.abs(e.quat.x * targetQ.x + e.quat.y * targetQ.y + e.quat.z * targetQ.z + e.quat.w * targetQ.w);
  const angle = Math.acos(Math.min(1, cosHalf)) * 2;
  const t = angle > 1e-5 ? Math.min(1, (E_MAX_ANG * dt) / angle) : 1;
  V.qSlerp(e.quat, e.quat, targetQ, Math.min(1, t * e.aggro + 0.02));

  // fire when roughly aimed and in range
  e.fireCd -= dt;
  if (e.fireCd <= 0 && d < 1250 && e.spawnGrace <= 0) {
    const fwd = V.set(TMP4, 0, 0, -1);
    V.qRotateVec(TMP4, e.quat, fwd);
    const aimDot = (TMP4.x * aimx + TMP4.y * aimy + TMP4.z * aimz) / (Math.sqrt(aimx * aimx + aimy * aimy + aimz * aimz) || 1);
    if (aimDot > 0.985) {
      e.fireCd = E_FIRE_INTERVAL * (0.75 + w.rng() * 0.6);
      const mx = e.pos.x + TMP4.x * (e.radius + 1.5);
      const my = e.pos.y + TMP4.y * (e.radius + 1.5);
      const mz = e.pos.z + TMP4.z * (e.radius + 1.5);
      const jitter = 0.012;
      fireBullet(w, KIND_ENEMY, mx, my, mz,
        TMP4.x + w.rng.gauss() * jitter, TMP4.y + w.rng.gauss() * jitter, TMP4.z + w.rng.gauss() * jitter,
        E_BULLET_SPEED, E_BULLET_DAMAGE, 3.4, e.kind);
      w.fx.emit(FX_MUZZLE, mx, my, mz, TMP4.x, TMP4.y, TMP4.z, 0.55, 0, e.kind, 0);
    } else {
      e.fireCd = 0.12;
    }
  }
}

// --- collisions ------------------------------------------------------------
function damageEnemy(w, e, dmg, hx, hy, hz) {
  e.health -= dmg;
  w.fx.emit(FX_IMPACT, hx, hy, hz, hx - e.pos.x, hy - e.pos.y, hz - e.pos.z, dmg * 0.4, 0, e.kind, 0);
  if (e.health <= 0) {
    e.alive = false;
    w.stats.kills++;
    w.fx.emit(FX_EXPLOSION, e.pos.x, e.pos.y, e.pos.z, e.radius * 1.5, e.kind === 1 ? 0.75 : 0.55, 1, 0, 0, 0, 0);
    const dp = Math.hypot(w.player.pos.x - e.pos.x, w.player.pos.y - e.pos.y, w.player.pos.z - e.pos.z);
    if (dp < 260) w.events.shake += (1 - dp / 260) * 0.8;
  }
}

function damageAsteroid(w, a, dmg, hx, hy, hz) {
  a.health -= dmg;
  w.fx.emit(FX_IMPACT, hx, hy, hz, hx - a.pos.x, hy - a.pos.y, hz - a.pos.z, dmg * 0.5, 1, 0, 0);
  if (a.health <= 0) {
    a.alive = false;
    w.fx.emit(FX_EXPLOSION, a.pos.x, a.pos.y, a.pos.z, a.radius * 1.1, 0.25, 0, 0, 0, 0, 0);
  }
}

function hurtPlayer(w, dmg, nx, ny, nz) {
  const p = w.player;
  if (!p.alive) return;
  p.lastHit = w.time;
  if (p.shield > 0) {
    const absorbed = Math.min(p.shield, dmg);
    p.shield -= absorbed;
    dmg -= absorbed;
    w.fx.emit(FX_SHIELD_HIT, p.pos.x + nx * p.radius, p.pos.y + ny * p.radius, p.pos.z + nz * p.radius, nx, ny, nz, absorbed, 0, 0, 0);
  }
  if (dmg > 0) {
    p.health -= dmg;
    w.events.playerHit++;
    w.events.shake += Math.min(1.2, dmg * 0.06);
    if (p.health <= 0) {
      p.health = 0; p.alive = false;
      w.fx.emit(FX_EXPLOSION, p.pos.x, p.pos.y, p.pos.z, 16, 0.9, 2, 0, 0, 0, 0);
    }
  } else {
    w.events.shake += 0.06;
  }
}

function collideBullets(w) {
  const bullets = w.bullets;
  for (let bi = 0; bi < bullets.length; bi++) {
    const b = bullets[bi];
    if (!b.alive) continue;
    const bx = b.pos.x, by = b.pos.y, bz = b.pos.z;

    // vs enemies
    if (b.owner === KIND_PLAYER) {
      const es = w.enemies;
      for (let ei = 0; ei < es.length; ei++) {
        const e = es[ei];
        if (!e.alive) continue;
        const dx = bx - e.pos.x, dy = by - e.pos.y, dz = bz - e.pos.z;
        const rr = e.radius + b.radius;
        if (dx * dx + dy * dy + dz * dz <= rr * rr) {
          w.stats.hits++;
          damageEnemy(w, e, b.damage, bx, by, bz);
          b.alive = false;
          break;
        }
      }
      if (!b.alive) continue;
      const as = w.asteroids;
      for (let ai = 0; ai < as.length; ai++) {
        const a = as[ai];
        if (!a.alive) continue;
        const dx = bx - a.pos.x, dy = by - a.pos.y, dz = bz - a.pos.z;
        const rr = a.radius + b.radius;
        if (dx * dx + dy * dy + dz * dz <= rr * rr) {
          w.stats.hits++;
          damageAsteroid(w, a, b.damage, bx, by, bz);
          b.alive = false;
          break;
        }
      }
    } else {
      const p = w.player;
      if (p.alive) {
        const dx = bx - p.pos.x, dy = by - p.pos.y, dz = bz - p.pos.z;
        const rr = p.radius + b.radius;
        if (dx * dx + dy * dy + dz * dz <= rr * rr) {
          b.alive = false;
          const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
          hurtPlayer(w, b.damage, -dx / l, -dy / l, -dz / l);
        }
      }
    }
  }
}

function collideBodies(w) {
  const p = w.player;
  if (!p.alive) return;
  const es = w.enemies;
  for (let i = 0; i < es.length; i++) {
    const e = es[i];
    if (!e.alive || e.spawnGrace > 0) continue;
    const dx = p.pos.x - e.pos.x, dy = p.pos.y - e.pos.y, dz = p.pos.z - e.pos.z;
    const rr = p.radius + e.radius;
    if (dx * dx + dy * dy + dz * dz <= rr * rr) {
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const impact = Math.abs((p.vel.x - e.vel.x) * dx + (p.vel.y - e.vel.y) * dy + (p.vel.z - e.vel.z) * dz) / l;
      hurtPlayer(w, 12 + impact * 0.12, dx / l, dy / l, dz / l);
      damageEnemy(w, e, 30 + impact * 0.2, e.pos.x - dx / l * e.radius, e.pos.y - dy / l * e.radius, e.pos.z - dz / l * e.radius);
      // bounce
      p.vel.x += (dx / l) * 22; p.vel.y += (dy / l) * 22; p.vel.z += (dz / l) * 22;
    }
  }
  const as = w.asteroids;
  for (let i = 0; i < as.length; i++) {
    const a = as[i];
    if (!a.alive) continue;
    const dx = p.pos.x - a.pos.x, dy = p.pos.y - a.pos.y, dz = p.pos.z - a.pos.z;
    const rr = p.radius + a.radius;
    if (dx * dx + dy * dy + dz * dz <= rr * rr) {
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const impact = Math.abs((p.vel.x - a.vel.x) * dx + (p.vel.y - a.vel.y) * dy + (p.vel.z - a.vel.z) * dz) / l;
      hurtPlayer(w, 20 + impact * 0.16, dx / l, dy / l, dz / l);
      p.vel.x += (dx / l) * 30; p.vel.y += (dy / l) * 30; p.vel.z += (dz / l) * 30;
    }
  }
  // planet surface
  if (p.pos.y < PLANET_SURFACE_Y + p.radius) {
    hurtPlayer(w, 9999, 0, 1, 0);
  }
}

// --- particles -------------------------------------------------------------
function updateParticles(w) {
  const p = w.particles;
  const dt = DT;
  let alive = 0;
  for (let i = 0; i < p.count; i++) {
    if (p.life[i] <= 0) continue;
    p.life[i] -= dt;
    if (p.life[i] <= 0) continue;
    // vacuum: no drag. Debris keeps momentum; embers slow slightly via radiation pressure proxy.
    p.px[i] += p.vx[i] * dt;
    p.py[i] += p.vy[i] * dt;
    p.pz[i] += p.vz[i] * dt;
    alive++;
  }
  w.stats.particlesAlive = alive;
}

// FX -> particles. Deterministic: each event uses a per-event derived RNG so the
// same event stream always produces the same particle field.
let _fxCursor = 0;
function consumeFxToParticles(w) {
  const fx = w.fx;
  const start = _fxCursor;
  const end = fx.seq;
  for (let k = start; k < end; k++) {
    const idx = k & (fx.capacity - 1);
    const t = fx.type[idx];
    const o = idx * 10;
    const x = fx.data[o], y = fx.data[o + 1], z = fx.data[o + 2];
    const a = fx.data[o + 3], b = fx.data[o + 4], c = fx.data[o + 5];
    const d = fx.data[o + 6], e = fx.data[o + 7];
    const r = makeRng(`fx:${k}`);
    if (t === FX_EXPLOSION) {
      const scale = a, heat = b;
      const n = Math.min(120, 34 + Math.round(scale * 3.2));
      for (let i = 0; i < n; i++) {
        const th = r() * 6.283185, ph = Math.acos(1 - 2 * r());
        const spd = (14 + r() * 62) * (0.5 + scale / 20);
        const life = 0.7 + r() * 2.3;
        const hot = heat;
        const rr = 1.0, gg = 0.45 + hot * 0.45, bb = 0.12 + hot * 0.35;
        spawnParticle(w, x, y, z,
          Math.sin(ph) * Math.cos(th) * spd, Math.cos(ph) * spd, Math.sin(ph) * Math.sin(th) * spd,
          life, 0.9 + r() * 2.6 * (scale / 12), rr, gg, bb, 1);
      }
      // slow ember core
      for (let i = 0; i < 14; i++) {
        const th = r() * 6.283185, ph = Math.acos(1 - 2 * r());
        const spd = (2 + r() * 9);
        spawnParticle(w, x, y, z,
          Math.sin(ph) * Math.cos(th) * spd, Math.cos(ph) * spd, Math.sin(ph) * Math.sin(th) * spd,
          2.6 + r() * 2.4, 3.4 + r() * 5, 1.0, 0.72, 0.35, 2);
      }
    } else if (t === FX_IMPACT) {
      const nx = a, ny = b, nz = c, energy = d;
      const n = Math.min(26, 6 + Math.round(energy * 2));
      for (let i = 0; i < n; i++) {
        const sp = 0.6 + r() * 2.2;
        const vx = (nx + r.gauss() * 0.75) * sp * 12;
        const vy = (ny + r.gauss() * 0.75) * sp * 12;
        const vz = (nz + r.gauss() * 0.75) * sp * 12;
        spawnParticle(w, x, y, z, vx, vy, vz, 0.28 + r() * 0.55, 0.5 + r() * 1.1, 1.0, 0.82, 0.45, 0);
      }
    } else if (t === FX_MUZZLE) {
      const dx = a, dy = b, dz = c, pow = d;
      const n = 5;
      for (let i = 0; i < n; i++) {
        spawnParticle(w, x, y, z,
          dx * (30 + r() * 40) + r.gauss() * 6,
          dy * (30 + r() * 40) + r.gauss() * 6,
          dz * (30 + r() * 40) + r.gauss() * 6,
          0.09 + r() * 0.12, 0.8 + r() * 1.2, 1.0, 0.85, 0.55, 3);
      }
    } else if (t === FX_SHIELD_HIT) {
      const nx = a, ny = b, nz = c, energy = d;
      const n = Math.min(22, 5 + Math.round(energy * 1.6));
      for (let i = 0; i < n; i++) {
        const sp = 4 + r() * 14;
        spawnParticle(w, x, y, z,
          (nx + r.gauss() * 0.9) * sp, (ny + r.gauss() * 0.9) * sp, (nz + r.gauss() * 0.9) * sp,
          0.22 + r() * 0.4, 0.7 + r() * 1.4, 0.35, 0.72, 1.0, 4);
      }
    }
  }
  _fxCursor = end;
}

// --- workload maintenance (keeps GPU load constant) ------------------------
function maintainCounts(w) {
  const cfg = w.cfg;
  let enemies = 0, bullets = 0, asteroids = 0;
  const es = w.enemies;
  for (let i = 0; i < es.length; i++) if (es[i].alive) enemies++;
  while (enemies < cfg.maxEnemies) {
    let placed = false;
    for (let i = 0; i < es.length; i++) {
      if (!es[i].alive) { spawnEnemy(w, es[i]); enemies++; placed = true; break; }
    }
    if (!placed) break;
  }
  const as = w.asteroids;
  for (let i = 0; i < as.length; i++) if (as[i].alive) asteroids++;
  while (asteroids < cfg.maxAsteroids) {
    let placed = false;
    for (let i = 0; i < as.length; i++) {
      if (!as[i].alive) { spawnAsteroid(w, as[i]); asteroids++; placed = true; break; }
    }
    if (!placed) break;
  }
  const bs = w.bullets;
  for (let i = 0; i < bs.length; i++) if (bs[i].alive) bullets++;
  // top up ambient fire so the projectile load is steady frame to frame
  let guard = 0;
  while (bullets < cfg.maxBullets && guard++ < 64) {
    const src = es[(w.frame + guard) % es.length];
    if (!src.alive) continue;
    const r = w.rng;
    const th = r() * 6.283185, ph = Math.acos(1 - 2 * r());
    const dx = Math.sin(ph) * Math.cos(th), dy = Math.cos(ph) * 0.6, dz = Math.sin(ph) * Math.sin(th);
    fireBullet(w, KIND_ENEMY,
      src.pos.x + dx * (src.radius + 2), src.pos.y + dy * (src.radius + 2), src.pos.z + dz * (src.radius + 2),
      dx, dy, dz, E_BULLET_SPEED * (0.7 + r() * 0.6), 0, 3.2, src.kind);
    bullets++;
  }
  // Hold the particle load constant too: micro-debris catching sunlight around the
  // fighter. Without this the FX budget depends on combat luck, not the workload.
  const pp = w.particles;
  let parts = 0;
  for (let i = 0; i < pp.count; i++) if (pp.life[i] > 0) parts++;
  let g2 = 0;
  while (parts < cfg.maxParticles && g2++ < 48) {
    const r = w.rng;
    spawnParticle(w,
      w.player.pos.x + r.range(-280, 280),
      w.player.pos.y + r.range(-190, 190),
      w.player.pos.z + r.range(-280, 280),
      r.range(-7, 7), r.range(-5, 5), r.range(-7, 7),
      1.4 + r() * 2.8, 0.09 + r() * 0.20, 0.52, 0.58, 0.66, 5);
    parts++;
  }
  w.stats.particlesAlive = parts;
  w.stats.enemiesAlive = enemies;
  w.stats.bulletsAlive = bullets;
}

// --- main step -------------------------------------------------------------
export function stepWorld(w, input) {
  updatePlayer(w, input);
  const es = w.enemies;
  for (let i = 0; i < es.length; i++) if (es[i].alive) updateEnemy(w, es[i]);

  const bs = w.bullets;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (!b.alive) continue;
    b.life -= DT;
    if (b.life <= 0) { b.alive = false; continue; }
    b.pos.x += b.vel.x * DT; b.pos.y += b.vel.y * DT; b.pos.z += b.vel.z * DT;
    if (b.pos.y < PLANET_SURFACE_Y) b.alive = false;
  }

  const as = w.asteroids;
  for (let i = 0; i < as.length; i++) {
    const a = as[i];
    if (!a.alive) continue;
    a.pos.x += a.vel.x * DT; a.pos.y += a.vel.y * DT; a.pos.z += a.vel.z * DT;
    const dq = QS;
    V.qFromAxisAngle(dq, a.angVel.x, a.angVel.y, a.angVel.z, len3(a.angVel) * DT);
    V.qMul(a.quat, a.quat, dq);
    V.qNormalize(a.quat, a.quat);
    if (a.pos.y < PLANET_SURFACE_Y - 20000) a.alive = false;
  }

  collideBullets(w);
  collideBodies(w);
  updateParticles(w);
  consumeFxToParticles(w);
  maintainCounts(w);

  w.frame++;
  w.time = w.frame * DT;
  w.events.shake *= 0.86;
  return w;
}

// Deterministic scripted pilot: a pure function of world state + seed.
// It flies an intercept solution and leads its shots, so the benchmark exercises
// real combat (hits, kills, explosions) rather than random wandering.
export function makeScriptedInput(seed) {
  const r = makeRng(`pilot:${seed}`);
  const base = { throttle: 0.8, pitch: 0, yaw: 0, roll: 0, fire: false, dampeners: true };
  const aim = V.v3(), bd = V.v3(), br = V.v3(), cq = V.q4();
  const R_AXIS = V.v3(1, 0, 0);
  let targetIdx = -1;
  let switchAt = 0;

  return function scripted(w, frame) {
    const p = w.player;

    if (frame >= switchAt) {
      switchAt = frame + 180 + r.int(0, 120);
      let best = Infinity;
      targetIdx = -1;
      const es = w.enemies;
      for (let i = 0; i < es.length; i++) {
        if (!es[i].alive) continue;
        const d2 = V.dist2(p.pos, es[i].pos);
        if (d2 < best) { best = d2; targetIdx = i; }
      }
    }

    const tgt = (targetIdx >= 0 && w.enemies[targetIdx].alive) ? w.enemies[targetIdx] : null;

    if (!tgt) {
      const t = frame * DT;
      base.pitch = Math.sin(t * 0.7) * 0.3;
      base.yaw = Math.sin(t * 0.5 + 1.1) * 0.35;
      base.roll = Math.sin(t * 0.4 + 2.2) * 0.4;
      base.throttle = 0.6;
      base.fire = false;
      return base;
    }

    // quadratic intercept: |r + v_rel * t| = boltSpeed * t
    const rx = tgt.pos.x - p.pos.x, ry = tgt.pos.y - p.pos.y, rz = tgt.pos.z - p.pos.z;
    const rvx = tgt.vel.x - p.vel.x, rvy = tgt.vel.y - p.vel.y, rvz = tgt.vel.z - p.vel.z;
    // bolts inherit the launcher's velocity, so the closure speed is muzzle + ship speed
    const bolt = BULLET_SPEED + Math.sqrt(p.vel.x * p.vel.x + p.vel.y * p.vel.y + p.vel.z * p.vel.z);
    const qa = rvx * rvx + rvy * rvy + rvz * rvz - bolt * bolt;
    const qb = 2 * (rx * rvx + ry * rvy + rz * rvz);
    const qc = rx * rx + ry * ry + rz * rz;
    let tt = 0;
    if (Math.abs(qa) < 1e-4) {
      tt = qb !== 0 ? -qc / qb : 0;
    } else {
      const disc = qb * qb - 4 * qa * qc;
      if (disc >= 0) {
        const s = Math.sqrt(disc);
        const t1 = (-qb - s) / (2 * qa), t2 = (-qb + s) / (2 * qa);
        const c1 = t1 >= 0 ? t1 : Infinity, c2 = t2 >= 0 ? t2 : Infinity;
        tt = Math.min(c1, c2);
        if (!isFinite(tt)) tt = 0;
      }
    }
    if (tt < 0) tt = 0;
    if (tt > 3) tt = 3;

    aim.x = tgt.pos.x + tgt.vel.x * tt - p.pos.x;
    aim.y = tgt.pos.y + tgt.vel.y * tt - p.pos.y;
    aim.z = tgt.pos.z + tgt.vel.z * tt - p.pos.z;
    const al = Math.sqrt(aim.x * aim.x + aim.y * aim.y + aim.z * aim.z) || 1;
    aim.x /= al; aim.y /= al; aim.z /= al;

    // world -> body frame
    V.qInv(cq, p.quat);
    V.qRotateVec(bd, cq, aim);
    // body right axis in world space, for roll stabilisation against planet up
    V.qRotateVec(br, p.quat, R_AXIS);

    const kp = 3.4;
    base.pitch = clamp1(bd.y * kp);
    base.yaw = clamp1(-bd.x * kp);
    base.roll = clamp1(-br.y * 1.9 + Math.sin(frame * DT * 0.23) * 0.05);

    const err = Math.abs(bd.x) + Math.abs(bd.y);
    base.fire = err < 0.18;
    const dist = Math.sqrt(rx * rx + ry * ry + rz * rz);
    base.throttle = dist > 520 ? 0.95 : (dist < 190 ? 0.35 : 0.7);
    return base;
  };
}

function clamp1(v) { return v < -1 ? -1 : (v > 1 ? 1 : v); }
