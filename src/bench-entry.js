// Headless benchmark entry. Drives the same game object as the interactive page,
// but with a fixed scripted pilot and a workload whose GPU cost is constant.
//
// Measurement note: Chrome's gl.finish() returns without waiting for the GPU
// (verified: identical samples at 720p and 1080p). Pipelined frame deltas DO
// track GPU cost (8.2ms @720p vs 16.8ms @1080p on the same build), so the
// pipelined loop is the measurement of record.

import { createGame } from './game.js';
import { makeScriptedInput, DT } from './core/sim.js';
import { FX_EXPLOSION } from './core/fx.js';

let game = null;
let scripted = null;
let frame = 0;

// Workload: one ship-kill explosion every EXPLOSION_PERIOD frames, so the
// fireball/shockwave/point-light path is exercised at a fixed rate instead of
// depending on how well the autopilot happens to shoot.
const EXPLOSION_PERIOD = 45;

function benchInput(w, f) {
  const inp = scripted(w, f);
  inp.fire = true;   // continuous cannon fire: muzzle flash + heat + tracers
  return inp;
}

function injectExplosion(w, f) {
  // deterministic placement around the fighter, at combat-relevant range
  const a = (f * 2.399963229728653) % 6.283185307179586; // golden angle
  const r = 180 + ((f * 37) % 220);
  const p = w.player.pos;
  w.fx.emit(
    FX_EXPLOSION,
    p.x + Math.cos(a) * r,
    p.y + Math.sin(a * 1.7) * r * 0.45,
    p.z + Math.sin(a) * r,
    12 + ((f * 13) % 10),        // scale
    0.35 + ((f * 7) % 50) / 100, // heat
    1, 0, 0, 0, 0
  );
}

window.__bench = {
  boot(canvas, opts = {}) {
    game = createGame(canvas, opts);
    scripted = makeScriptedInput(opts.seed || 'bench');
    frame = 0;
    window.__booted = true;
    window.__game = game;
  },

  // Pipelined frames with per-frame deltas. The GPU queue backs up under load, so
  // these deltas converge on true frame cost rather than CPU submit time.
  run(frames) {
    const out = new Array(frames);
    let prev = performance.now();
    for (let i = 0; i < frames; i++) {
      if (i % EXPLOSION_PERIOD === 0) injectExplosion(game.world, frame);
      game.frame(benchInput(game.world, frame), DT);
      const now = performance.now();
      out[i] = now - prev;
      prev = now;
      frame++;
    }
    return out;
  },

  // Forced GPU sync via readPixels. Chrome's finish() is a no-op across the GPU
  // process boundary; a 1-pixel readback genuinely blocks until the frame lands.
  runSynced(frames) {
    const gl = game.renderer.getContext();
    const buf = new Uint8Array(4);
    const out = new Array(frames);
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      if (i % EXPLOSION_PERIOD === 0) injectExplosion(game.world, frame);
      game.frame(benchInput(game.world, frame), DT);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      out[i] = performance.now() - t0;
      frame++;
    }
    return out;
  },

  // Read the GL framebuffer immediately after a render. Reading a WebGL canvas
  // later (drawImage/toDataURL) yields black without preserveDrawingBuffer, so
  // this is the only trustworthy way to inspect what actually drew.
  capture() {
    const gl = game.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { w, h, buf: Array.from(buf) };
  },

  analyze() {
    const gl = game.renderer.getContext();
    // Render and read in the same JS turn: once the frame is presented the
    // drawing buffer is discarded (preserveDrawingBuffer is off), so a read
    // issued later sees black.
    game.render(1 / 60);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // sample on a coarse grid for speed
    const sx = Math.max(1, Math.floor(w / 320)), sy = Math.max(1, Math.floor(h / 180));
    let nonBlack = 0, bright = 0, veryBright = 0, n = 0;
    let sr = 0, sg = 0, sb = 0, maxL = 0;
    let maxAt = null;
    const colors = new Set();
    const bands = new Array(6).fill(0), bandN = new Array(6).fill(0);
    for (let y = 0; y < h; y += sy) {
      const band = Math.min(5, Math.floor((y / h) * 6));
      for (let x = 0; x < w; x += sx) {
        const i = (y * w + x) * 4;
        const r = buf[i], g = buf[i + 1], b = buf[i + 2];
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        sr += r; sg += g; sb += b; n++;
        if (L > 6) nonBlack++;
        if (L > 60) bright++;
        if (L > 200) veryBright++;
        if (L > maxL) { maxL = L; maxAt = [Math.round(x / w * 100), Math.round(y / h * 100)]; }
        colors.add((r >> 4) + ',' + (g >> 4) + ',' + (b >> 4));
        bands[band] += L; bandN[band]++;
      }
    }
    return {
      sampled: n,
      pctNonBlack: +(100 * nonBlack / n).toFixed(1),
      pctBright: +(100 * bright / n).toFixed(1),
      pctVeryBright: +(100 * veryBright / n).toFixed(2),
      meanRGB: [+(sr / n).toFixed(1), +(sg / n).toFixed(1), +(sb / n).toFixed(1)],
      distinctColors: colors.size,
      maxLuminance: +maxL.toFixed(0),
      maxAtPct: maxAt,
      verticalBands: bands.map((s, i) => +(s / bandN[i]).toFixed(1)),
    };
  },

  // Legacy alias kept for the serialized variant (CPU-submit-only; not the metric).
  runSerialized(frames) {
    const gl = game.renderer.getContext();
    const out = new Array(frames);
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      game.frame(benchInput(game.world, frame), DT);
      gl.finish();
      out[i] = performance.now() - t0;
      frame++;
    }
    return out;
  },

  stats() {
    const info = game.renderer.info;
    return {
      ...game.world.stats,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs ? info.programs.length : 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };
  },

  setExposure(v) { game.renderer.toneMappingExposure = v; },
  isReady() { return !!window.__booted; },
};

window.__booted = false;

// Auto-boot from query-string options so the driver only has to wait for readiness.
const qs = new URLSearchParams(location.search);
const num = (k, d) => (qs.has(k) ? parseFloat(qs.get(k)) : d);
const bootOpts = {
  seed: qs.get('seed') || 'bench',
  width: innerWidth,
  height: innerHeight,
  pixelRatio: num('dpr', 1),
  enemies: num('enemies', 24),
  bullets: num('bullets', 320),
  particles: num('particles', 2400),
  asteroids: num('asteroids', 6),
  stars: num('stars', 7000),
  planetTexSize: num('planetTexSize', 2048),
  bloomStrength: num('bloom', 0.62),
  bloomRadius: num('bloomRadius', 0.62),
  bloomThreshold: num('bloomThreshold', 0.55),
  exposure: num('exposure', 0.78),
  shadows: qs.get('shadows') !== '0',
  // Overrides for the shipped shadow defaults; absent => environment.js defaults.
  shadowMapSize: qs.has('shadowSize') ? Math.round(num('shadowSize', 0)) : undefined,
  shadowExtent: qs.has('shadowExtent') ? Math.round(num('shadowExtent', 0)) : undefined,
  shadowStatic: qs.get('shadowStatic') === '1',
  ablate: qs.get('ablate') || '',
  lens: {
    ca: num('ca', 0.0028),
    grain: num('grain', 0.055),
    vignette: num('vignette', 0.55),
    dirt: num('dirt', 0.10),
  },
};

function autoBoot() {
  const canvas = document.getElementById('gl');
  if (!canvas) return;
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  try {
    window.__bench.boot(canvas, bootOpts);
  } catch (err) {
    window.__bootError = String((err && err.stack) || err);
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoBoot);
else autoBoot();
