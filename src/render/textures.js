/**
 * textures.js — procedural PBR texture generation.
 *
 * Pure, deterministic and DOM-free: every generator is driven by an explicit `seed`
 * through a local PRNG (never `Math.random`), writes into preallocated typed arrays,
 * and hands back `THREE.DataTexture` instances. No canvas, no `Image`, no network.
 * The module is importable in plain Node.
 *
 * Tiling strategy
 * ---------------
 * Value noise is built on a 256-period permutation lattice, so a lattice index masked
 * with `(period-1)` wraps exactly. Any field sampled with an integer number of lattice
 * cells across the tile is therefore seamless with no blending needed.
 *
 * For the hull's large-scale wear field we additionally sample 4D value noise on a
 * flat 2-torus — (cos a, sin a, cos b, sin b) — which is seamless in both axes for
 * *any* radius, because the mapping itself is exactly periodic.
 *
 * Cost model (measured, Apple M2 Pro): v2 9ns, v3 26ns, v4 32ns per sample.
 * Consequently the expensive 3D/4D fields are generated at quarter/half resolution
 * and bilinearly upsampled, while full-resolution passes stay on cheap 2D lookups.
 */

import * as THREE from 'three';

const TAU = Math.PI * 2;
const INV255 = 1 / 255;

/* ------------------------------------------------------------------ PRNG -- */

function mulberry32(a) {
  a = a >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normalise any seed value to a well-mixed uint32. */
function seedU32(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return (seed | 0) >>> 0;
  const s = String(seed);
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Fisher-Yates shuffled 256-entry lattice, doubled for +1 offset lookups. */
function buildPerm(seed) {
  const rnd = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const a = new Uint8Array(256);
  for (let i = 0; i < 256; i++) a[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  const p = new Uint8Array(512);
  for (let i = 0; i < 256; i++) { p[i] = a[i]; p[256 + i] = a[i]; }
  return p;
}

/* ----------------------------------------------------------- math helpers -- */

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** '#rrggbb' -> [r,g,b] in 0..1 (authored in sRGB, written straight to sRGB maps). */
function hexRGB(hex) {
  const s = typeof hex === 'string' ? hex.replace('#', '') : '000000';
  const n = parseInt(s.length === 3 ? s[0] + s[0] + s[1] + s[1] + s[2] + s[2] : s, 16) | 0;
  return [((n >> 16) & 255) * INV255, ((n >> 8) & 255) * INV255, (n & 255) * INV255];
}

/* ------------------------------------------------------------ value noise -- */

/**
 * 2D value noise on a wrapping lattice. `mx`/`my` are period-minus-one masks;
 * pass 255 for non-tiling use, or (cells-1) to tile at `cells` lattice cells.
 */
function v2(P, x, y, mx, my) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = xi & mx, x1 = (xi + 1) & mx;
  const y0 = yi & my, y1 = (yi + 1) & my;
  const a = P[P[x0] + y0], b = P[P[x1] + y0];
  const c = P[P[x0] + y1], d = P[P[x1] + y1];
  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return (ab + (cd - ab) * v) * INV255;
}

/** 3D value noise, lattice wraps at 256 in every axis. */
function v3(P, x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);
  const x0 = xi & 255, x1 = (xi + 1) & 255;
  const y0 = yi & 255, y1 = (yi + 1) & 255;
  const z0 = zi & 255, z1 = (zi + 1) & 255;
  const X0 = P[x0], X1 = P[x1];
  const A = P[X0 + y0], B = P[X0 + y1], C = P[X1 + y0], D = P[X1 + y1];
  const a0 = P[A + z0], a1 = P[A + z1];
  const b0 = P[B + z0], b1 = P[B + z1];
  const c0 = P[C + z0], c1 = P[C + z1];
  const d0 = P[D + z0], d1 = P[D + z1];
  const ax = a0 + (b0 - a0) * u, bx = a1 + (b1 - a1) * u;
  const cx = c0 + (d0 - c0) * u, dx = c1 + (d1 - c1) * u;
  const ay = ax + (cx - ax) * v, by = bx + (dx - bx) * v;
  return (ay + (by - ay) * w) * INV255;
}

/**
 * 4D value noise. Corner hashes share lattice prefixes (2+4+8+16 lookups instead of
 * 64), which is what keeps the torus-wrapped fields affordable.
 */
function v4(P, x, y, z, w) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), wi = Math.floor(w);
  const fx = x - xi, fy = y - yi, fz = z - zi, fw = w - wi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const s = fz * fz * (3 - 2 * fz);
  const t = fw * fw * (3 - 2 * fw);
  const x0 = xi & 255, x1 = (xi + 1) & 255;
  const y0 = yi & 255, y1 = (yi + 1) & 255;
  const z0 = zi & 255, z1 = (zi + 1) & 255;
  const w0 = wi & 255, w1 = (wi + 1) & 255;
  const X0 = P[x0], X1 = P[x1];
  const XY00 = P[X0 + y0], XY01 = P[X0 + y1], XY10 = P[X1 + y0], XY11 = P[X1 + y1];
  const Z00 = P[XY00 + z0], Z01 = P[XY00 + z1], Z10 = P[XY01 + z0], Z11 = P[XY01 + z1];
  const Z20 = P[XY10 + z0], Z21 = P[XY10 + z1], Z30 = P[XY11 + z0], Z31 = P[XY11 + z1];
  const a000 = P[Z00 + w0], a001 = P[Z00 + w1];
  const a010 = P[Z01 + w0], a011 = P[Z01 + w1];
  const a100 = P[Z10 + w0], a101 = P[Z10 + w1];
  const a110 = P[Z11 + w0], a111 = P[Z11 + w1];
  const b000 = P[Z20 + w0], b001 = P[Z20 + w1];
  const b010 = P[Z21 + w0], b011 = P[Z21 + w1];
  const b100 = P[Z30 + w0], b101 = P[Z30 + w1];
  const b110 = P[Z31 + w0], b111 = P[Z31 + w1];
  const c000 = a000 + (b000 - a000) * u, c001 = a001 + (b001 - a001) * u;
  const c010 = a010 + (b010 - a010) * u, c011 = a011 + (b011 - a011) * u;
  const c100 = a100 + (b100 - a100) * u, c101 = a101 + (b101 - a101) * u;
  const c110 = a110 + (b110 - a110) * u, c111 = a111 + (b111 - a111) * u;
  const d00 = c000 + (c010 - c000) * v, d01 = c001 + (c011 - c001) * v;
  const d10 = c100 + (c110 - c100) * v, d11 = c101 + (c111 - c101) * v;
  const e0 = d00 + (d10 - d00) * s, e1 = d01 + (d11 - d01) * s;
  return (e0 + (e1 - e0) * t) * INV255;
}

/** Normalised fbm over v2. `lac` must be 2 for the tiling masks to stay integral. */
function fbm2(P, x, y, oct, lac, gain, mx, my) {
  let sum = 0, norm = 0, f = 1, g = 1;
  for (let o = 0; o < oct; o++) {
    sum += v2(P, x * f, y * f, Math.min(mx, (256 / lac) | 0) === 0 ? mx : mx, my) * g;
    norm += g;
    f *= lac; g *= gain;
  }
  return sum / norm;
}

function fbm3(P, x, y, z, oct, lac, gain) {
  let sum = 0, norm = 0, f = 1, g = 1;
  for (let o = 0; o < oct; o++) {
    sum += v3(P, x * f, y * f, z * f) * g;
    norm += g;
    f *= lac; g *= gain;
  }
  return sum / norm;
}

function fbm4(P, x, y, z, w, oct, lac, gain) {
  let sum = 0, norm = 0, f = 1, g = 1;
  for (let o = 0; o < oct; o++) {
    sum += v4(P, x * f, y * f, z * f, w * f) * g;
    norm += g;
    f *= lac; g *= gain;
  }
  return sum / norm;
}

/* ------------------------------------------------------- sampling helpers -- */

/** Bilinear sample of a square wrapping field (size must be a power of two). */
function sampleWrap(f, S, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = x - xi, ty = y - yi;
  const m = S - 1;
  const x0 = xi & m, x1 = (xi + 1) & m;
  const r0 = (yi & m) * S, r1 = ((yi + 1) & m) * S;
  const a = f[r0 + x0], b = f[r0 + x1], c = f[r1 + x0], d = f[r1 + x1];
  const ab = a + (b - a) * tx, cd = c + (d - c) * tx;
  return ab + (cd - ab) * ty;
}

/** Bilinear sample that wraps in x and clamps in y (equirectangular fields). */
function sampleEQ(f, W, H, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = x - xi, ty = y - yi;
  const m = W - 1;
  const x0 = xi & m, x1 = (xi + 1) & m;
  let y0 = yi < 0 ? 0 : yi > H - 1 ? H - 1 : yi;
  let y1 = yi + 1 < 0 ? 0 : yi + 1 > H - 1 ? H - 1 : yi + 1;
  const r0 = y0 * W, r1 = y1 * W;
  const a = f[r0 + x0], b = f[r0 + x1], c = f[r1 + x0], d = f[r1 + x1];
  const ab = a + (b - a) * tx, cd = c + (d - c) * tx;
  return ab + (cd - ab) * ty;
}

/* ------------------------------------------------------ texture packaging -- */

function dataTex(data, w, h, srgb, tiled) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
  if (tiled) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
  } else {
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearFilter;
  }
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Single-channel linear data replicated across RGB so any channel read works. */
function grayTex(data, w, h, tiled) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.LinearSRGBColorSpace;
  if (tiled) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
  } else {
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearFilter;
  }
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/* ================================================================ noise === */

/**
 * Seeded noise bundle, exported for reuse by other render modules.
 * All values are 0..1 and a pure function of `seed`.
 */
export function makeNoise(seed) {
  const P = buildPerm(seedU32(seed));
  const out = {
    value2(x, y) { return v2(P, x, y, 255, 255); },
    fbm2(x, y, octaves = 5, lac = 2, gain = 0.5) { return fbm2(P, x, y, octaves, lac, gain, 255, 255); },
    value3(x, y, z) { return v3(P, x, y, z); },
    fbm3(x, y, z, octaves = 5, lac = 2, gain = 0.5) { return fbm3(P, x, y, z, octaves, lac, gain); },
    curl2(x, y, o) {
      const r = o && typeof o === 'object' ? o : { x: 0, y: 0 };
      const e = 0.01, ie = 1 / (2 * e);
      const dy = fbm2(P, x, y + e, 4, 2, 0.5, 255, 255) - fbm2(P, x, y - e, 4, 2, 0.5, 255, 255);
      const dx = fbm2(P, x + e, y, 4, 2, 0.5, 255, 255) - fbm2(P, x - e, y, 4, 2, 0.5, 255, 255);
      r.x = dy * ie;
      r.y = -dx * ie;
      return r;
    },
    // Extras: the 4D core behind the torus-wrapped hull fields.
    value4(x, y, z, w) { return v4(P, x, y, z, w); },
    fbm4(x, y, z, w, octaves = 4, lac = 2, gain = 0.5) { return fbm4(P, x, y, z, w, octaves, lac, gain); },
  };
  return out;
}

/* ============================================================== the hull == */

/**
 * Build the large-scale seamless field on a flat 2-torus in R4.
 * Returned array is `S x S` and wraps in both axes for any radius.
 */
function torusField(P, S, cells, oct, gain) {
  const R = cells / TAU;
  const cosT = new Float32Array(S);
  const sinT = new Float32Array(S);
  for (let i = 0; i < S; i++) {
    const a = (TAU * i) / S;
    cosT[i] = Math.cos(a) * R;
    sinT[i] = Math.sin(a) * R;
  }
  const f = new Float32Array(S * S);
  for (let j = 0; j < S; j++) {
    const z = cosT[j], w = sinT[j];
    const row = j * S;
    for (let i = 0; i < S; i++) {
      f[row + i] = fbm4(P, cosT[i], sinT[i], z, w, oct, 2, gain);
    }
  }
  return f;
}

/** Add a soft circular bump/dip into a field, wrapping at the edges. */
function splatDisk(f, W, H, cx, cy, r, amp) {
  const r2 = r * r;
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
  const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  const mx = W - 1, my = H - 1;
  for (let j = y0; j <= y1; j++) {
    const dy = j - cy;
    const row = (j & my) * W;
    for (let i = x0; i <= x1; i++) {
      const dx = i - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const t = 1 - d2 / r2;
      f[row + (i & mx)] += amp * t * t;
    }
  }
}

/** Rasterise a slightly curved scratch line into `scratch` (0..1) and `hgt`. */
function splatScratch(P, scratch, hgt, W, H, x, y, ang, len, wide, amp, rnd) {
  const step = 1.0;
  const steps = Math.max(2, len | 0);
  const w2 = wide * wide;
  const mx = W - 1, my = H - 1;
  let a = ang;
  let px = x, py = y;
  for (let s = 0; s < steps; s++) {
    a += (v2(P, px * 0.05, py * 0.05, 255, 255) - 0.5) * 0.16;
    px += Math.cos(a) * step;
    py += Math.sin(a) * step;
    const taper = 1 - Math.abs((s / steps) * 2 - 1);
    const inten = amp * (0.35 + 0.65 * taper);
    const r = wide;
    const ix0 = Math.floor(px - r), ix1 = Math.ceil(px + r);
    const iy0 = Math.floor(py - r), iy1 = Math.ceil(py + r);
    for (let j = iy0; j <= iy1; j++) {
      const dy = j - py;
      const row = (j & my) * W;
      for (let i = ix0; i <= ix1; i++) {
        const dx = i - px;
        const d2 = dx * dx + dy * dy;
        if (d2 > w2) continue;
        const t = 1 - d2 / w2;
        const idx = row + (i & mx);
        const v = scratch[idx] + inten * t;
        scratch[idx] = v > 1 ? 1 : v;
        hgt[idx] -= inten * t * 0.02;
      }
    }
  }
  void rnd;
}

const HULL_DEFAULTS = {
  paint: '#3a4148',
  accent: null,
  accentChance: 0,
  metal: '#b4bec6',
  primer: '#8d949b',
  panelMajor: [4, 3],
  panelMinor: [11, 9],
  wear: 1,
  scratches: 1,
  rivets: 1,
  grime: 1,
};

/**
 * Shared implementation behind `hullMaps` / `liveryMaps`.
 *
 * All five maps are derived from the same height / wear / grime / scratch fields so
 * features agree across the set: seams are darker, rougher and recessed; chips are
 * brighter, smoother and fully metallic.
 */
function hullCore(seed, size, opt) {
  const S = size | 0;
  const N = S * S;
  const sc = S / 1024;
  const P = buildPerm(seedU32(seed));
  const rnd = mulberry32((seedU32(seed) ^ 0x5bf03635) >>> 0);

  const paint = hexRGB(opt.paint);
  const metal = hexRGB(opt.metal);
  const primer = hexRGB(opt.primer);
  const accent = opt.accent ? hexRGB(opt.accent) : null;

  const hgt = new Float32Array(N);
  const wear = new Float32Array(N);   // 0 = intact paint, 1 = bare metal
  const grime = new Float32Array(N);
  const scratch = new Float32Array(N);
  const panel = new Uint8Array(N);    // 0 = base paint, 1 = accent paint

  // --- large-scale seamless field (quarter res, torus-wrapped 4D fbm) --------
  const BS = Math.max(32, S >> 2);
  const big = torusField(P, BS, 3.2, 5, 0.55);

  // Grain / streak grids: integer cell counts keep the lattice wrap exact.
  const G = Math.min(256, Math.max(32, S >> 2));
  const GM = G - 1;
  const SX = 32, SY = 8;

  const [MX, MY] = opt.panelMajor;
  const [NX, NY] = opt.panelMinor;
  const invMX = 1 / MX, invMY = 1 / MY;
  const invNX = 1 / NX, invNY = 1 / NY;

  const seamWMajor = 3.4 * sc;
  const seamWMinor = 1.7 * sc;
  const seamDepth = 0.30;
  const wearAmt = opt.wear;
  const chipLo = 0.615, chipHi = 0.648;

  // --- pass 1: height, wear, grime, panel assignment ------------------------
  for (let j = 0; j < S; j++) {
    const v = (j + 0.5) / S;
    const row = j * S;
    const fyM = v * MY, fym = fyM - Math.floor(fyM);
    const fyn = v * NY, fynm = fyn - Math.floor(fyn);
    const cyM = Math.floor(fyM), cyN = Math.floor(fyn);
    const dym = Math.min(fym, 1 - fym) * S * invMY;
    const dyn = Math.min(fynm, 1 - fynm) * S * invNY;

    for (let i = 0; i < S; i++) {
      const u = (i + 0.5) / S;
      const idx = row + i;

      // torus field: reused for dents, seam wobble and wear bias. Sampling at
      // integer multiples of the base mapping preserves the exact wrap.
      const b1 = sampleWrap(big, BS, u * BS, v * BS);
      const b2 = sampleWrap(big, BS, u * BS * 2 + 17, v * BS * 2 + 29);

      const fxM = u * MX, fxmm = fxM - Math.floor(fxM);
      const fxN = u * NX, fxnn = fxN - Math.floor(fxN);
      const dxm = Math.min(fxmm, 1 - fxmm) * S * invMX;
      const dxn = Math.min(fxnn, 1 - fxnn) * S * invNX;

      // per-cell seam width variation so the grid does not read as uniform
      const cxN = Math.floor(fxN);
      const wVar = 0.7 + 0.6 * (P[(P[(cxN & 255) + (cyN & 255)] & 255)] * INV255);

      const wob = (b1 - 0.5) * 2.6 * sc;
      const dm = dxm + dym + wob;
      const dn = dxn + dyn + wob * 0.7;

      const sMajor = 1 - smoothstep(0, seamWMajor * wVar, dm);
      const sMinor = 1 - smoothstep(0, seamWMinor * wVar, dn);
      const seam = sMajor > sMinor ? sMajor : sMinor;

      const grain = v2(P, u * G, v * G, GM, GM);
      const streak = v2(P, u * SX, v * SY, SX - 1, SY - 1);

      // height: broad oil-canning, structural dents, recessed seams
      let h = (b1 - 0.5) * 0.42 + (b2 - 0.5) * 0.12;
      h -= seam * seamDepth;
      h += (grain - 0.5) * 0.02;

      // wear: chips nucleate on edges and in broad high-wear patches
      let w = 0.60 * b2 + 0.34 * seam + 0.16 * (1 - grain);
      w = w * wearAmt;
      const chip = smoothstep(chipLo, chipHi, w);
      wear[idx] = chip;
      // paint has thickness: chipped areas sit lower, torn edge sits slightly proud
      h -= chip * 0.055;
      h += smoothstep(chipLo - 0.055, chipLo, w) * (1 - chip) * 0.022;

      // grime: settles in cavities and washes down in vertical streaks
      let g = streak * 0.42 + seam * 0.55 + (0.5 - b1) * 0.25;
      g *= opt.grime;
      grime[idx] = g < 0 ? 0 : g > 1 ? 1 : g;

      hgt[idx] = h;

      if (accent !== null) {
        const a = (P[(P[((cxN + 61) & 255) + ((cyN + 29) & 255)] & 255)] * INV255);
        panel[idx] = a < opt.accentChance ? 1 : 0;
      }
    }
  }

  // --- pass 2: rivets, scratches, impact stars ------------------------------
  const rivetR = 2.3 * sc;
  const rivetAmp = 0.16 * opt.rivets;
  if (rivetAmp > 0) {
    // double rows of fasteners running parallel to every minor seam
    const step = Math.max(8, 22 * sc);
    const inset = 5.5 * sc;
    for (let k = 0; k < NX; k++) {
      const x = (k / NX) * S;
      const cnt = Math.floor(S / step);
      const phase = (P[(k * 7 + 3) & 255] / 255) * step;
      for (let n = 0; n < cnt; n++) {
        const y = phase + n * step;
        splatDisk(hgt, S, S, x - inset, y, rivetR, rivetAmp);
        splatDisk(hgt, S, S, x + inset, y, rivetR, rivetAmp);
      }
    }
    for (let k = 0; k < NY; k++) {
      const y = (k / NY) * S;
      const cnt = Math.floor(S / step);
      const phase = (P[(k * 13 + 91) & 255] / 255) * step;
      for (let n = 0; n < cnt; n++) {
        const x = phase + n * step;
        splatDisk(hgt, S, S, x, y - inset, rivetR, rivetAmp);
        splatDisk(hgt, S, S, x, y + inset, rivetR, rivetAmp);
      }
    }
  }

  const nScr = Math.round(240 * opt.scratches * (S / 1024));
  for (let k = 0; k < nScr; k++) {
    const x = rnd() * S, y = rnd() * S;
    const axis = rnd() < 0.72 ? 0 : Math.PI / 2;
    const ang = axis + (rnd() - 0.5) * 0.34;
    const len = 24 + rnd() * 320 * (S / 1024);
    const wide = 0.9 + rnd() * 1.5;
    const amp = 0.25 + rnd() * 0.6;
    splatScratch(P, scratch, hgt, S, S, x, y, ang, len, wide, amp, rnd);
  }

  // impact stars: a chip core with radial cracks
  const nImp = Math.round(18 * opt.wear);
  for (let k = 0; k < nImp; k++) {
    const cx = rnd() * S, cy = rnd() * S;
    const rCore = (4 + rnd() * 9) * sc;
    splatDisk(wear, S, S, cx, cy, rCore, 1.4);
    splatDisk(hgt, S, S, cx, cy, rCore * 1.15, -0.07);
    const arms = 4 + ((rnd() * 5) | 0);
    for (let a = 0; a < arms; a++) {
      const ang = rnd() * TAU;
      const len = rCore * (2 + rnd() * 3.5);
      splatScratch(P, scratch, hgt, S, S, cx, cy, ang, len, 1.1 * sc, 0.55, rnd);
    }
  }

  // --- pass 3: cavity AO from a quarter-res blur of the height field --------
  const QS = Math.max(16, S >> 2);
  const q = new Float32Array(QS * QS);
  const bs = S / QS;
  const invBS2 = 1 / (bs * bs);
  for (let j = 0; j < QS; j++) {
    const j0 = Math.floor(j * bs), j1 = Math.min(S - 1, Math.floor((j + 1) * bs));
    const row = j * QS;
    for (let i = 0; i < QS; i++) {
      const i0 = Math.floor(i * bs), i1 = Math.min(S - 1, Math.floor((i + 1) * bs));
      let acc = 0;
      for (let jj = j0; jj <= j1; jj++) {
        const r = jj * S;
        for (let ii = i0; ii <= i1; ii++) acc += hgt[r + ii];
      }
      q[row + i] = acc * invBS2;
    }
  }

  // --- pass 4: derive all five maps ----------------------------------------
  const cCol = new Uint8Array(N * 4);
  const cRgh = new Uint8Array(N * 4);
  const cMet = new Uint8Array(N * 4);
  const cNrm = new Uint8Array(N * 4);
  const cAO = new Uint8Array(N * 4);

  const nStrength = 5.2;

  for (let j = 0; j < S; j++) {
    const row = j * S;
    const jm = (j === 0 ? S - 1 : j - 1) * S;
    const jp = (j === S - 1 ? 0 : j + 1) * S;
    const v = (j + 0.5) / S;

    for (let i = 0; i < S; i++) {
      const idx = row + i;
      const im = i === 0 ? S - 1 : i - 1;
      const ip = i === S - 1 ? 0 : i + 1;
      const u = (i + 0.5) / S;

      const h = hgt[idx];
      const chip = wear[idx] > 1 ? 1 : wear[idx];
      const gr = grime[idx];
      const sr = scratch[idx];

      // tangent-space normal from central differences of the shared height field
      const dX = (hgt[row + im] - hgt[row + ip]) * nStrength;
      const dY = (hgt[jm + i] - hgt[jp + i]) * nStrength;
      const invLen = 1 / Math.sqrt(dX * dX + dY * dY + 1);

      // cavity AO: height below its local average means occlusion
      const blur = sampleWrap(q, QS, u * QS, v * QS);
      let ao = 1 - clamp01((blur - h) * 1.35) * 0.72;
      ao *= 1 - sr * 0.10;
      ao = ao < 0 ? 0 : ao > 1 ? 1 : ao;

      // ---- colour ----
      const b1 = sampleWrap(big, BS, u * BS, v * BS);
      const tint = 1 + (b1 - 0.5) * 0.16;
      let pr = paint[0], pg = paint[1], pb = paint[2];
      if (accent !== null && panel[idx] === 1) { pr = accent[0]; pg = accent[1]; pb = accent[2]; }

      // primer shows at the very edge of a chip, bare metal in the middle
      const bare = smoothstep(0.35, 0.85, chip);
      const prim = clamp01(chip * 4 * (1 - bare));
      let r = pr * tint, g = pg * tint, b = pb * tint;
      r = r * (1 - prim) + primer[0] * prim;
      g = g * (1 - prim) + primer[1] * prim;
      b = b * (1 - prim) + primer[2] * prim;
      const mm = metal[0] * (0.92 + 0.16 * sr), mn = metal[1] * (0.92 + 0.16 * sr), mo = metal[2] * (0.92 + 0.16 * sr);
      r = r * (1 - bare) + mm * bare;
      g = g * (1 - bare) + mn * bare;
      b = b * (1 - bare) + mo * bare;

      // scratches polish the paint and expose metal underneath
      const scrMetal = sr * (0.35 + 0.55 * chip);
      r += (mm - r) * scrMetal * 0.75;
      g += (mn - g) * scrMetal * 0.75;
      b += (mo - b) * scrMetal * 0.75;

      // grime darkens everything, warm-shifted
      const gd = gr * 0.5;
      r *= 1 - gd * 0.92;
      g *= 1 - gd * 0.96;
      b *= 1 - gd * 1.06;
      // seam shadow
      const sh = 1 - clamp01((blur - h) * 1.6) * 0.35;
      r *= sh; g *= sh; b *= sh;

      const o4 = idx * 4;
      cCol[o4] = (r < 0 ? 0 : r > 1 ? 255 : r * 255) | 0;
      cCol[o4 + 1] = (g < 0 ? 0 : g > 1 ? 255 : g * 255) | 0;
      cCol[o4 + 2] = (b < 0 ? 0 : b > 1 ? 255 : b * 255) | 0;
      cCol[o4 + 3] = 255;

      // ---- roughness: polished bare metal, matte paint, rough seams ----
      let rough = 0.46 + (b1 - 0.5) * 0.10 + sr * 0.04;
      rough = rough * (1 - bare) + (0.13 + 0.06 * sr) * bare;
      rough += gr * 0.34;
      rough += clamp01((blur - h) * 1.4) * 0.22;
      rough -= sr * 0.12;
      if (rough < 0.06) rough = 0.06; else if (rough > 0.98) rough = 0.98;
      const rv = (rough * 255) | 0;
      cRgh[o4] = rv; cRgh[o4 + 1] = rv; cRgh[o4 + 2] = rv; cRgh[o4 + 3] = 255;

      // ---- metalness ----
      let met = 0.18 + sr * 0.25;
      met = met * (1 - bare) + 1 * bare;
      const seamMetal = clamp01((blur - h) * 1.5) * 0.55;
      if (seamMetal > met) met = seamMetal;
      met = met * (1 - gr * 0.45);
      const mv = (met * 255) | 0;
      cMet[o4] = mv; cMet[o4 + 1] = mv; cMet[o4 + 2] = mv; cMet[o4 + 3] = 255;

      // ---- normal ----
      cNrm[o4] = ((dX * invLen * 0.5 + 0.5) * 255) | 0;
      cNrm[o4 + 1] = ((dY * invLen * 0.5 + 0.5) * 255) | 0;
      cNrm[o4 + 2] = (invLen * 0.5 + 0.5) * 255;
      cNrm[o4 + 3] = 255;

      // ---- ao ----
      const av = (ao * 255) | 0;
      cAO[o4] = av; cAO[o4 + 1] = av; cAO[o4 + 2] = av; cAO[o4 + 3] = 255;
    }
  }

  return {
    color: dataTex(cCol, S, S, true, true),
    roughness: grayTex(cRgh, S, S, true),
    metalness: grayTex(cMet, S, S, true),
    normal: dataTex(cNrm, S, S, false, true),
    ao: grayTex(cAO, S, S, true),
  };
}

/**
 * Tiled spaceship hull: worn aerospace alloy with panel seams, rivets, chipped
 * paint revealing bare metal, machining scratches and cavity grime.
 */
export function hullMaps(seed, size = 1024) {
  return hullCore(seed, size, HULL_DEFAULTS);
}

/** Painted accent panels for fighter liveries; same PBR structure as the hull. */
export function liveryMaps(seed, size = 512, baseHex = '#2a3138', accentHex = '#c8452c') {
  return hullCore(seed, size, {
    paint: baseHex,
    accent: accentHex,
    accentChance: 0.42,
    metal: '#c2ccd4',
    primer: '#9a9088',
    panelMajor: [3, 2],
    panelMinor: [9, 7],
    wear: 0.72,
    scratches: 0.8,
    rivets: 1,
    grime: 0.75,
  });
}

/* ============================================================= the planet = */

/**
 * Earth-like planet, equirectangular (u = longitude, v = latitude).
 *
 * Terrain and moisture are sampled as 3D noise on the unit sphere, which is the
 * exact solution to the equirectangular pole-pinch: features keep a constant
 * world-space size at every latitude and the map is seamless in u by construction,
 * with no cos(lat) frequency resampling needed.
 */
export function planetMaps(seed, size = 2048) {
  const W = size | 0;
  const H = Math.max(2, (size >> 1) | 0);
  const N = W * H;
  const P = buildPerm(seedU32(seed));

  // terrain + moisture at half resolution (viewed from orbit this is plenty)
  const TW = Math.max(64, W >> 1);
  const TH = Math.max(32, H >> 1);
  const TN = TW * TH;

  const terrH = new Float32Array(TN);
  const terrM = new Float32Array(TN);
  const terrDX = new Float32Array(TN);
  const terrDY = new Float32Array(TN);

  const cosLon = new Float32Array(TW);
  const sinLon = new Float32Array(TW);
  for (let i = 0; i < TW; i++) {
    const a = (TAU * (i + 0.5)) / TW;
    cosLon[i] = Math.cos(a);
    sinLon[i] = Math.sin(a);
  }
  const cosLat = new Float32Array(TH);
  const sinLat = new Float32Array(TH);
  for (let j = 0; j < TH; j++) {
    const t = Math.PI * ((j + 0.5) / TH); // 0..PI from north pole to south
    sinLat[j] = Math.cos(t);              // sin(lat)
    cosLat[j] = Math.sin(t);              // cos(lat)
  }

  const TF = 1.55;
  for (let j = 0; j < TH; j++) {
    const cl = cosLat[j], sl = sinLat[j];
    const row = j * TW;
    for (let i = 0; i < TW; i++) {
      const px = cl * cosLon[i];
      const py = sl;
      const pz = cl * sinLon[i];
      // low-frequency domain warp -> irregular continents and coastlines
      const wx = v3(P, px * 0.85 + 11.3, py * 0.85 + 2.7, pz * 0.85 + 5.1) - 0.5;
      const wy = v3(P, px * 0.85 + 4.1, py * 0.85 + 19.4, pz * 0.85 + 8.8) - 0.5;
      const wz = v3(P, px * 0.85 + 7.7, py * 0.85 + 1.3, pz * 0.85 + 13.9) - 0.5;
      const sx = (px + wx * 0.42) * TF;
      const sy = (py + wy * 0.42) * TF;
      const sz = (pz + wz * 0.42) * TF;
      terrH[row + i] = fbm3(P, sx, sy, sz, 6, 2, 0.5);
      terrM[row + i] = fbm3(P, sx * 0.7 + 31.7, sy * 0.7 + 9.1, sz * 0.7 + 21.3, 4, 2, 0.5);
    }
  }

  // terrain gradients (central differences, wrapping in x) for the normal map
  for (let j = 0; j < TH; j++) {
    const row = j * TW;
    const jm = (j === 0 ? TH - 1 : j - 1) * TW;
    const jp = (j === TH - 1 ? 0 : j + 1) * TW;
    for (let i = 0; i < TW; i++) {
      const im = i === 0 ? TW - 1 : i - 1;
      const ip = i === TW - 1 ? 0 : i + 1;
      terrDX[row + i] = terrH[row + ip] - terrH[row + im];
      terrDY[row + i] = terrH[jp + i] - terrH[jm + i];
    }
  }

  const cCol = new Uint8Array(N * 4);
  const cRgh = new Uint8Array(N * 4);
  const cNrm = new Uint8Array(N * 4);

  // biome palette (sRGB)
  const deep = hexRGB('#04192f');
  const mid = hexRGB('#0a3f68');
  const shallow = hexRGB('#1f7f9e');
  const sand = hexRGB('#c3b183');
  const desert = hexRGB('#c8a05c');
  const shrub = hexRGB('#8f9a5e');
  const grass = hexRGB('#638b3e');
  const forest = hexRGB('#2e4a26');
  const tundra = hexRGB('#9aa38f');
  const rock = hexRGB('#6e675e');
  const snow = hexRGB('#eef2f5');
  const ice = hexRGB('#e4edf4');

  const SEA = 0.5;
  const G = Math.min(256, Math.max(64, W >> 3));
  const GM = G - 1;

  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H;
    const row = j * W;
    const a = Math.abs(v - 0.5) * 2;              // 0 equator -> 1 pole
    const ty = v * TH - 0.5;

    for (let i = 0; i < W; i++) {
      const u = (i + 0.5) / W;
      const idx = row + i;
      const o4 = idx * 4;

      const h = sampleEQ(terrH, TW, TH, u * TW - 0.5, ty);
      const m = sampleEQ(terrM, TW, TH, u * TW - 0.5, ty);

      let r, g, b, rough;

      if (h < SEA) {
        const depth = clamp01((SEA - h) / (SEA * 0.85));
        const d = Math.pow(depth, 0.65);
        r = shallow[0] + (deep[0] - shallow[0]) * d;
        g = shallow[1] + (deep[1] - shallow[1]) * d;
        b = shallow[2] + (deep[2] - shallow[2]) * d;
        const t2 = clamp01(d * 1.4);
        r = r * (1 - t2) + mid[0] * t2 * 0.5 + r * t2 * 0.5;
        g = g * (1 - t2) + mid[1] * t2 * 0.5 + g * t2 * 0.5;
        b = b * (1 - t2) + mid[2] * t2 * 0.5 + b * t2 * 0.5;
        rough = 0.045 + 0.02 * (1 - depth);
      } else {
        const alt = clamp01((h - SEA) / (1 - SEA));
        const temp = clamp01(1.06 - a * 1.28 - alt * 0.72);

        const wForest = smoothstep(0.50, 0.80, m) * smoothstep(0.02, 0.34, temp);
        const wGrass = smoothstep(0.28, 0.52, m) * (1 - wForest) * smoothstep(0.12, 0.40, temp);
        const wDesert = (1 - wGrass) * (1 - wForest) * smoothstep(0.44, 0.74, temp);
        const wTundra = (1 - wForest) * (1 - wGrass) * (1 - wDesert);

        r = forest[0] * wForest + grass[0] * wGrass + desert[0] * wDesert + tundra[0] * wTundra;
        g = forest[1] * wForest + grass[1] * wGrass + desert[1] * wDesert + tundra[1] * wTundra;
        b = forest[2] * wForest + grass[2] * wGrass + desert[2] * wDesert + tundra[2] * wTundra;

        rough = 0.92 * wForest + 0.84 * wGrass + 0.74 * wDesert + 0.88 * wTundra;

        // beach band just above the waterline
        const beach = smoothstep(0.035, 0.0, alt) * smoothstep(0.0, 0.3, m);
        r = r * (1 - beach) + sand[0] * beach;
        g = g * (1 - beach) + sand[1] * beach;
        b = b * (1 - beach) + sand[2] * beach;
        rough = rough * (1 - beach) + 0.66 * beach;

        // high ground turns to bare rock then snow
        const rk = smoothstep(0.42, 0.68, alt) * (1 - smoothstep(0.80, 0.95, alt));
        r = r * (1 - rk) + rock[0] * rk;
        g = g * (1 - rk) + rock[1] * rk;
        b = b * (1 - rk) + rock[2] * rk;
        rough = rough * (1 - rk) + 0.68 * rk;

        const sn = smoothstep(0.78, 0.9, alt);
        r = r * (1 - sn) + snow[0] * sn;
        g = g * (1 - sn) + snow[1] * sn;
        b = b * (1 - sn) + snow[2] * sn;
        rough = rough * (1 - sn) + 0.42 * sn;

        // shrub transition keeps the forest/desert boundary from banding
        const shr = wDesert * smoothstep(0.30, 0.5, m) * (1 - wForest);
        r = r * (1 - shr) + shrub[0] * shr;
        g = r * 0 + g * (1 - shr) + shrub[1] * shr;
        b = b * (1 - shr) + shrub[2] * shr;
      }

      // --- polar ice caps -------------------------------------------------
      const iceNoise = v2(P, u * 48, v * 48, 47, 47);
      const iceLine = 0.80 + (iceNoise - 0.5) * 0.11;
      const icy = smoothstep(iceLine, iceLine + 0.075, a);
      if (icy > 0) {
        r = r * (1 - icy) + ice[0] * icy;
        g = g * (1 - icy) + ice[1] * icy;
        b = b * (1 - icy) + ice[2] * icy;
        rough = rough * (1 - icy) + 0.26 * icy;
      }

      // --- normal: upsampled terrain relief + full-res micro detail ------
      const ddx = sampleEQ(terrDX, TW, TH, u * TW - 0.5, ty);
      const ddy = sampleEQ(terrDY, TW, TH, u * TW - 0.5, ty);
      const fine = v2(P, u * G, v * G, GM, GM) - 0.5;
      const fine2 = v2(P, u * G * 0.5, v * G * 0.5, GM, GM) - 0.5;
      const micro = fine * 0.05 + fine2 * 0.09;

      let nx = (ddx * 9.0 + micro) * (1 - icy * 0.75);
      let ny = (ddy * 9.0 + micro) * (1 - icy * 0.75);
      if (h < SEA) { nx *= 0.06; ny *= 0.06; }
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);

      cCol[o4] = (r < 0 ? 0 : r > 1 ? 255 : r * 255) | 0;
      cCol[o4 + 1] = (g < 0 ? 0 : g > 1 ? 255 : g * 255) | 0;
      cCol[o4 + 2] = (b < 0 ? 0 : b > 1 ? 255 : b * 255) | 0;
      cCol[o4 + 3] = 255;

      const rv = (rough < 0.02 ? 0.02 : rough > 1 ? 1 : rough) * 255;
      cRgh[o4] = rv | 0; cRgh[o4 + 1] = rv | 0; cRgh[o4 + 2] = rv | 0; cRgh[o4 + 3] = 255;

      cNrm[o4] = ((nx * inv * 0.5 + 0.5) * 255) | 0;
      cNrm[o4 + 1] = ((ny * inv * 0.5 + 0.5) * 255) | 0;
      cNrm[o4 + 2] = (inv * 0.5 + 0.5) * 255;
      cNrm[o4 + 3] = 255;
    }
  }

  // --- cloud deck: separate seamless RGBA, alpha = coverage -----------------
  const CW = TW, CH = TH;
  const cCloud = new Uint8Array(CW * CH * 4);
  // anisotropic lattice: 4 cells across 360 of longitude vs 16 pole-to-pole
  const CX = 4, CY = 16;
  const warpX = new Float32Array(CW * CH);
  const warpY = new Float32Array(CW * CH);
  for (let j = 0; j < CH; j++) {
    const v = (j + 0.5) / CH;
    const row = j * CW;
    for (let i = 0; i < CW; i++) {
      const u = (i + 0.5) / CW;
      warpX[row + i] = fbm2(P, u * 8, v * 8, 3, 2, 0.5, 7, 7);
      warpY[row + i] = fbm2(P, u * 8 + 40, v * 8 + 17, 3, 2, 0.5, 7, 7);
    }
  }
  // latitude cloud belts: ITCZ at the equator, stormy mid-latitudes, dry subtropics
  const belt = new Float32Array(CH);
  for (let j = 0; j < CH; j++) {
    const a = Math.abs((j + 0.5) / CH - 0.5) * 2;
    belt[j] =
      0.62 * Math.exp(-(a * a) / (2 * 0.10 * 0.10)) +
      0.52 * Math.exp(-((a - 0.52) * (a - 0.52)) / (2 * 0.13 * 0.13)) +
      0.30 * Math.exp(-((a - 0.86) * (a - 0.86)) / (2 * 0.09 * 0.09)) -
      0.42 * Math.exp(-((a - 0.28) * (a - 0.28)) / (2 * 0.09 * 0.09));
  }

  for (let j = 0; j < CH; j++) {
    const v = (j + 0.5) / CH;
    const row = j * CW;
    const b = belt[j];
    for (let i = 0; i < CW; i++) {
      const u = (i + 0.5) / CW;
      const k = row + i;
      const wx = warpX[k] - 0.5, wy = warpY[k] - 0.5;
      const n = fbm2(P, u * CX + wx * 1.6, v * CY + wy * 1.1, 6, 2, 0.55, CX - 1, CY - 1);
      const cov = smoothstep(0.52 - b * 0.22, 0.78 - b * 0.22, n);
      const soft = clamp01(cov * 1.05);
      const shade = 232 + ((n - 0.5) * 46) | 0;
      const o4 = k * 4;
      cCloud[o4] = shade > 255 ? 255 : shade < 0 ? 0 : shade;
      cCloud[o4 + 1] = shade > 255 ? 255 : shade < 0 ? 0 : shade;
      cCloud[o4 + 2] = 255;
      cCloud[o4 + 3] = (soft * 255) | 0;
    }
  }

  return {
    color: dataTex(cCol, W, H, true, false),
    roughness: grayTex(cRgh, W, H, false),
    normal: dataTex(cNrm, W, H, false, false),
    clouds: dataTex(cCloud, CW, CH, true, false),
  };
}

/* ============================================================ gas giant === */

/** Banded gas giant: latitude bands sheared by differential rotation + a storm. */
export function gasGiantMaps(seed, size = 1024) {
  const W = size | 0;
  const H = Math.max(2, (size >> 1) | 0);
  const N = W * H;
  const P = buildPerm(seedU32(seed));
  const rnd = mulberry32((seedU32(seed) ^ 0x2c9e3d75) >>> 0);

  const cCol = new Uint8Array(N * 4);
  const cRgh = new Uint8Array(N * 4);
  const cNrm = new Uint8Array(N * 4);
  const turb = new Float32Array(N);

  const cA = hexRGB('#d8b98a');
  const cB = hexRGB('#a9714a');
  const cC = hexRGB('#e8dcc4');
  const cD = hexRGB('#8a6a52');
  const storm = hexRGB('#b4512f');

  const CX = 8, CY = 24;
  const shear = 6.5;
  const stormU = 0.31 + rnd() * 0.4;
  const stormV = 0.38 + rnd() * 0.22;
  const stormRU = 0.075 + rnd() * 0.04;
  const stormRV = 0.045 + rnd() * 0.02;

  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H;
    const row = j * W;
    const a = (v - 0.5) * 2;
    for (let i = 0; i < W; i++) {
      const u = (i + 0.5) / W;
      const idx = row + i;
      const o4 = idx * 4;

      // latitude-dependent horizontal shear -> the streaked, rotating look
      const t = fbm2(P, u * CX + a * shear, v * CY, 5, 2, 0.55, CX - 1, CY - 1);
      turb[idx] = t;

      const band = v + (t - 0.5) * 0.055;
      const s1 = 0.5 + 0.5 * Math.sin(band * Math.PI * 9.0 + 0.6);
      const s2 = 0.5 + 0.5 * Math.sin(band * Math.PI * 4.0 - 1.1);
      const s3 = 0.5 + 0.5 * Math.sin(band * Math.PI * 15.0 + 2.2);

      let r = cA[0] * s1 + cB[0] * (1 - s1);
      let g = cA[1] * s1 + cB[1] * (1 - s1);
      let b = cA[2] * s1 + cB[2] * (1 - s1);
      r = r * 0.72 + (cC[0] * s2 + cD[0] * (1 - s2)) * 0.28;
      g = g * 0.72 + (cC[1] * s2 + cD[1] * (1 - s2)) * 0.28;
      b = b * 0.72 + (cC[2] * s2 + cD[2] * (1 - s2)) * 0.28;
      const fine = (s3 - 0.5) * 0.06;
      r += fine; g += fine * 0.8; b += fine * 0.6;

      // the storm: an oval with its own swirl
      let du = u - stormU;
      du -= Math.round(du);
      const dv = v - stormV;
      const d2 = (du / stormRU) * (du / stormRU) + (dv / stormRV) * (dv / stormRV);
      if (d2 < 1.6) {
        const k = smoothstep(1.6, 0.25, d2);
        const swirl = 0.5 + 0.5 * Math.sin(Math.atan2(dv / stormRV, du / stormRU) * 3 + d2 * 5);
        r = r * (1 - k) + (storm[0] * (0.8 + 0.35 * swirl)) * k;
        g = g * (1 - k) + (storm[1] * (0.8 + 0.35 * swirl)) * k;
        b = b * (1 - k) + (storm[2] * (0.8 + 0.35 * swirl)) * k;
      }

      // polar darkening
      const pol = smoothstep(0.72, 1.0, Math.abs(a)) * 0.28;
      r *= 1 - pol; g *= 1 - pol; b *= 1 - pol;

      cCol[o4] = (r < 0 ? 0 : r > 1 ? 255 : r * 255) | 0;
      cCol[o4 + 1] = (g < 0 ? 0 : g > 1 ? 255 : g * 255) | 0;
      cCol[o4 + 2] = (b < 0 ? 0 : b > 1 ? 255 : b * 255) | 0;
      cCol[o4 + 3] = 255;

      const rough = 0.30 + (t - 0.5) * 0.22 + s1 * 0.08;
      const rv = (rough < 0.05 ? 0.05 : rough > 1 ? 1 : rough) * 255;
      cRgh[o4] = rv | 0; cRgh[o4 + 1] = rv | 0; cRgh[o4 + 2] = rv | 0; cRgh[o4 + 3] = 255;
    }
  }

  for (let j = 0; j < H; j++) {
    const row = j * W;
    const jm = (j === 0 ? H - 1 : j - 1) * W;
    const jp = (j === H - 1 ? 0 : j + 1) * W;
    for (let i = 0; i < W; i++) {
      const idx = row + i;
      const o4 = idx * 4;
      const im = i === 0 ? W - 1 : i - 1;
      const ip = i === W - 1 ? 0 : i + 1;
      const nx = (turb[row + im] - turb[row + ip]) * 2.2;
      const ny = (turb[jm + i] - turb[jp + i]) * 2.2;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      cNrm[o4] = ((nx * inv * 0.5 + 0.5) * 255) | 0;
      cNrm[o4 + 1] = ((ny * inv * 0.5 + 0.5) * 255) | 0;
      cNrm[o4 + 2] = (inv * 0.5 + 0.5) * 255;
      cNrm[o4 + 3] = 255;
    }
  }

  return {
    color: dataTex(cCol, W, H, true, false),
    roughness: grayTex(cRgh, W, H, false),
    normal: dataTex(cNrm, W, H, false, false),
  };
}

/* ========================================================= lens artifacts = */

/** Additive RGBA grime/scratches for a lens-dirt pass. */
export function lensDirt(seed, size = 512) {
  const S = size | 0;
  const P = buildPerm(seedU32(seed));
  const rnd = mulberry32((seedU32(seed) ^ 0x7a1b2c3d) >>> 0);
  const acc = new Float32Array(S * S);
  const tint = new Float32Array(S * S * 2); // warm/cool balance per pixel

  // soft smudges
  const sm = new Float32Array(S * S);
  const nSmudge = 26;
  for (let k = 0; k < nSmudge; k++) {
    const cx = rnd() * S, cy = rnd() * S;
    const r = (18 + rnd() * 70) * (S / 512);
    splatDisk(sm, S, S, cx, cy, r, 0.5 + rnd() * 0.5);
  }
  // break the smudges up with a mid-frequency field
  for (let j = 0; j < S; j++) {
    const v = (j + 0.5) / S;
    const row = j * S;
    for (let i = 0; i < S; i++) {
      const u = (i + 0.5) / S;
      const n = fbm2(P, u * 12, v * 12, 4, 2, 0.55, 11, 11);
      const k = row + i;
      const m = sm[k] * smoothstep(0.32, 0.62, n);
      acc[k] += m * 0.55;
      tint[k * 2] += m * (0.4 + n * 0.6);
    }
  }

  // dust specks
  const nSpeck = Math.round(900 * (S / 512) * (S / 512));
  for (let k = 0; k < nSpeck; k++) {
    const cx = rnd() * S, cy = rnd() * S;
    const r = (0.6 + rnd() * 2.2) * (S / 512);
    splatDisk(acc, S, S, cx, cy, r, 0.25 + rnd() * 0.7);
  }

  // hairline scratches across the element
  const nScr = 22;
  for (let k = 0; k < nScr; k++) {
    const x = rnd() * S, y = rnd() * S;
    const ang = rnd() * TAU;
    const len = 60 + rnd() * (S * 0.9);
    const wide = 0.7 + rnd() * 1.4;
    const amp = 0.18 + rnd() * 0.5;
    const scratch = new Float32Array(0);
    void scratch;
    const steps = len | 0;
    let a = ang, px = x, py = y;
    for (let s = 0; s < steps; s++) {
      px += Math.cos(a); py += Math.sin(a);
      const taper = 1 - Math.abs((s / steps) * 2 - 1);
      const inten = amp * (0.25 + 0.75 * taper);
      const r = wide;
      const ix0 = Math.floor(px - r), ix1 = Math.ceil(px + r);
      const iy0 = Math.floor(py - r), iy1 = Math.ceil(py + r);
      for (let jj = iy0; jj <= iy1; jj++) {
        const dy = jj - py;
        const yy = ((jj % S) + S) % S;
        const row = yy * S;
        for (let ii = ix0; ii <= ix1; ii++) {
          const dx = ii - px;
          const d2 = dx * dx + dy * dy;
          if (d2 > wide * wide) continue;
          const t = 1 - d2 / (wide * wide);
          const idx = row + (((ii % S) + S) % S);
          const val = acc[idx] + inten * t;
          acc[idx] = val > 1 ? 1 : val;
          tint[idx * 2] += inten * t * 0.8;
        }
      }
    }
  }

  // ring of grime toward the barrel edge
  for (let j = 0; j < S; j++) {
    const dy = (j + 0.5) / S - 0.5;
    const row = j * S;
    for (let i = 0; i < S; i++) {
      const dx = (i + 0.5) / S - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const ring = smoothstep(0.62, 0.92, r) * 0.5;
      const k = row + i;
      acc[k] += ring * (0.35 + 0.65 * tint[k * 2]);
    }
  }

  const out = new Uint8Array(S * S * 4);
  for (let j = 0; j < S; j++) {
    const row = j * S;
    for (let i = 0; i < S; i++) {
      const k = row + i;
      const o4 = k * 4;
      const a = clamp01(acc[k]);
      const warm = clamp01(tint[k * 2]);
      out[o4] = (a * (210 + warm * 45) > 255 ? 255 : a * (210 + warm * 45)) | 0;
      out[o4 + 1] = (a * (196 + warm * 30) > 255 ? 255 : a * (196 + warm * 30)) | 0;
      out[o4 + 2] = (a * (178 + warm * 12) > 255 ? 255 : a * (178 + warm * 12)) | 0;
      out[o4 + 3] = (a * 255) | 0;
    }
  }
  return dataTex(out, S, S, true, false);
}

/** Horizontal strip of `n` radial flare sprites, additive RGBA. */
export function flareSprites(seed, n = 6, size = 256) {
  const S = size | 0;
  const count = Math.max(1, n | 0);
  const W = S * count;
  const P = buildPerm(seedU32(seed));
  const rnd = mulberry32((seedU32(seed) ^ 0x31e5a77b) >>> 0);
  const out = new Uint8Array(W * S * 4);

  const hues = [
    [1.0, 0.92, 0.72],
    [0.72, 0.86, 1.0],
    [1.0, 0.66, 0.38],
    [0.78, 1.0, 0.86],
    [0.92, 0.74, 1.0],
    [1.0, 0.98, 0.94],
  ];

  for (let s = 0; s < count; s++) {
    const h = hues[s % hues.length];
    const pow = 1.4 + rnd() * 3.4;
    const ringR = 0.34 + rnd() * 0.4;
    const ringW = 0.02 + rnd() * 0.07;
    const hasRing = rnd() < 0.5;
    const hexy = rnd() < 0.34;
    const base = s * S;

    for (let j = 0; j < S; j++) {
      const dy = ((j + 0.5) / S) * 2 - 1;
      const row = (j * W + base) * 4;
      for (let i = 0; i < S; i++) {
        const dx = ((i + 0.5) / S) * 2 - 1;
        let r = Math.sqrt(dx * dx + dy * dy);
        if (hexy && r > 1e-6) {
          // squash the disc toward a hexagon for a blade-like ghost
          const ang = Math.atan2(dy, dx);
          const k = 1 / Math.cos(((ang % (Math.PI / 3)) - Math.PI / 6) * 2);
          r *= 1 + (k - 1.32) * 0.12;
        }
        let a = Math.pow(Math.max(0, 1 - r), pow);
        if (hasRing) {
          const d = Math.abs(r - ringR);
          a += Math.max(0, 1 - d / ringW) * 0.42;
        }
        if (r < 0.06) a += (0.06 - r) * 6;
        a = clamp01(a);
        const o = row + i * 4;
        out[o] = (a * h[0] * 255) | 0;
        out[o + 1] = (a * h[1] * 255) | 0;
        out[o + 2] = (a * h[2] * 255) | 0;
        out[o + 3] = (a * 255) | 0;
      }
    }
    void P;
  }
  return dataTex(out, W, S, true, false);
}
