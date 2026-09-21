// Interactive shell: input -> deterministic sim -> render + HUD.

import { createGame, makeScriptedInput } from './game.js';
import { DT } from './core/sim.js';
import { createHud } from './ui/hud.js';

const canvas = document.getElementById('gl');
const hudRoot = document.getElementById('hud');

const game = createGame(canvas, { seed: 'voidline', width: innerWidth, height: innerHeight });
const hud = createHud(hudRoot);

const input = { throttle: 0.5, pitch: 0, yaw: 0, roll: 0, fire: false, dampeners: true };
const keys = new Set();
let mouseDX = 0, mouseDY = 0;
let pointerLocked = false;
let autopilot = false;
let paused = false;

addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyX') input.dampeners = !input.dampeners;
  if (e.code === 'KeyP') autopilot = !autopilot;
  if (e.code === 'KeyH') hudRoot.style.display = hudRoot.style.display === 'none' ? '' : 'none';
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));

canvas.addEventListener('click', () => {
  if (!pointerLocked) canvas.requestPointerLock?.();
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
});
addEventListener('mousemove', (e) => {
  if (!pointerLocked) return;
  mouseDX += e.movementX;
  mouseDY += e.movementY;
});
addEventListener('mousedown', (e) => { if (pointerLocked && e.button === 0) input.fire = true; });
addEventListener('mouseup', (e) => { if (e.button === 0) input.fire = false; });
addEventListener('blur', () => { paused = true; });
addEventListener('focus', () => { paused = false; });

const scripted = makeScriptedInput('voidline');

function readInput(frame) {
  if (autopilot) return scripted(game.world, frame);
  const up = keys.has('KeyW') || keys.has('ArrowUp');
  const down = keys.has('KeyS') || keys.has('ArrowDown');
  if (up) input.throttle = Math.min(1, input.throttle + 0.035);
  if (down) input.throttle = Math.max(0, input.throttle - 0.045);
  if (keys.has('ShiftLeft') || keys.has('ShiftRight')) input.throttle = 1;

  // mouse gives pitch/yaw, A/D gives roll
  const mx = mouseDX, my = mouseDY;
  mouseDX = 0; mouseDY = 0;
  input.pitch = clamp(-my * 0.0055 - (keys.has('ArrowUp') ? 0.4 : 0) + (keys.has('ArrowDown') ? 0.4 : 0));
  input.yaw = clamp(-mx * 0.0055);
  input.roll = clamp((keys.has('KeyA') ? 1 : 0) - (keys.has('KeyD') ? 1 : 0));
  if (keys.has('Space')) input.fire = true; else if (!pointerLocked) input.fire = false;
  input.dampeners = input.dampeners && !keys.has('KeyC');
  return input;
}
function clamp(v) { return v < -1 ? -1 : v > 1 ? 1 : v; }

let last = performance.now();
let acc = 0;
let frame = 0;
let fps = 60;

function loop(now) {
  requestAnimationFrame(loop);
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  fps = fps * 0.92 + (1 / Math.max(dt, 1e-4)) * 0.08;
  if (paused) return;

  acc += dt;
  let steps = 0;
  while (acc >= DT && steps < 5) {
    game.frame(readInput(frame), DT);
    acc -= DT;
    frame++;
    steps++;
  }
  if (steps === 0) { game.syncScene(dt); game.render(dt); }

  const w = game.world;
  const p = w.player;
  const info = game.renderer.info;
  hud.update({
    speed: Math.hypot(p.vel.x, p.vel.y, p.vel.z),
    throttle: p.throttle,
    altitude: p.pos.y - (-6371000 - 4200),
    health: p.health, maxHealth: p.maxHealth,
    shield: p.shield, maxShield: p.maxShield,
    heat: p.heat, overheat: p.overheated,
    score: w.stats.kills * 100 + w.stats.hits * 4,
    combo: w.stats.kills,
    enemiesAlive: w.stats.enemiesAlive,
    wave: 1,
    fps,
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    radar: buildRadar(w),
    radarRange: 1400,
    target: pickTarget(w),
    warnings: buildWarnings(p),
    dampeners: p.dampeners,
    rcs: Math.abs(p.rcsP) + Math.abs(p.rcsY) + Math.abs(p.rcsR),
    damageDirs: DAMAGEDIR,
  }, dt);
}

const DAMAGEDIR = new Float32Array(0);
const radarBuf = new Float32Array(4 * 128);
function buildRadar(w) {
  let n = 0;
  const p = w.player.pos;
  radarBuf[n * 4] = p.x; radarBuf[n * 4 + 1] = p.y; radarBuf[n * 4 + 2] = p.z; radarBuf[n * 4 + 3] = 0; n++;
  for (let i = 0; i < w.enemies.length && n < 127; i++) {
    const e = w.enemies[i];
    if (!e.alive) continue;
    radarBuf[n * 4] = e.pos.x; radarBuf[n * 4 + 1] = e.pos.y; radarBuf[n * 4 + 2] = e.pos.z; radarBuf[n * 4 + 3] = 1; n++;
  }
  for (let i = 0; i < w.asteroids.length && n < 127; i++) {
    const a = w.asteroids[i];
    if (!a.alive) continue;
    radarBuf[n * 4] = a.pos.x; radarBuf[n * 4 + 1] = a.pos.y; radarBuf[n * 4 + 2] = a.pos.z; radarBuf[n * 4 + 3] = 2; n++;
  }
  return radarBuf.subarray(0, n * 4);
}

function pickTarget(w) {
  const p = w.player;
  const fx = new (Object)();
  let best = null, bestDot = 0.965;
  const fwdX = -(2 * (p.quat.x * p.quat.z + p.quat.w * p.quat.y));
  const fwdY = -(2 * (p.quat.y * p.quat.z - p.quat.w * p.quat.x));
  const fwdZ = -(1 - 2 * (p.quat.x * p.quat.x + p.quat.y * p.quat.y));
  for (let i = 0; i < w.enemies.length; i++) {
    const e = w.enemies[i];
    if (!e.alive) continue;
    const dx = e.pos.x - p.pos.x, dy = e.pos.y - p.pos.y, dz = e.pos.z - p.pos.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const dot = (dx * fwdX + dy * fwdY + dz * fwdZ) / d;
    if (dot > bestDot) { bestDot = dot; best = { name: e.kind === 1 ? 'HEAVY' : 'RAIDER', dist: d, health: e.health / e.maxHealth, lead: { x: e.pos.x, y: e.pos.y, z: e.pos.z } }; }
  }
  return best;
}

function buildWarnings(p) {
  const out = [];
  if (p.overheated) out.push('OVERHEAT');
  if (p.health < 35) out.push('HULL CRITICAL');
  if (p.shield <= 0) out.push('SHIELD DOWN');
  return out;
}

addEventListener('resize', () => game.setSize(innerWidth, innerHeight));
requestAnimationFrame(loop);
