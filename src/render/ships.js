// Procedural spacecraft. Each craft is merged into a single BufferGeometry with
// material groups so a whole squadron renders in a handful of instanced draw calls.
//
// Groups: 0 hull  1 accent/livery  2 canopy glass  3 engine glow  4 dark machinery

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hullMaps, liveryMaps } from './textures.js';

export const G_HULL = 0, G_ACCENT = 1, G_GLASS = 2, G_ENGINE = 3, G_DARK = 4;

export function createShipMaterials(seed) {
  const hull = hullMaps(seed, 1024);
  const accent = liveryMaps(seed + ':accent', 512, '#242a30', '#c8452c');
  const playerLivery = liveryMaps(seed + ':player', 512, '#2b3238', '#3f8fbf');

  const hullMat = new THREE.MeshPhysicalMaterial({
    map: hull.color,
    roughnessMap: hull.roughness,
    metalnessMap: hull.metalness,
    normalMap: hull.normal,
    aoMap: hull.ao,
    aoMapIntensity: 0.85,
    normalScale: new THREE.Vector2(1.15, 1.15),
    metalness: 1.0,
    roughness: 1.0,
    clearcoat: 0.28,
    clearcoatRoughness: 0.22,
    envMapIntensity: 1.25,
  });

  const accentMat = new THREE.MeshPhysicalMaterial({
    map: accent.color,
    roughnessMap: accent.roughness,
    metalnessMap: accent.metalness,
    normalMap: accent.normal,
    aoMap: accent.ao,
    normalScale: new THREE.Vector2(1.0, 1.0),
    metalness: 0.85,
    roughness: 1.0,
    clearcoat: 0.4,
    clearcoatRoughness: 0.18,
    envMapIntensity: 1.1,
  });

  const playerAccentMat = accentMat.clone();
  playerAccentMat.map = playerLivery.color;
  playerAccentMat.roughnessMap = playerLivery.roughness;
  playerAccentMat.metalnessMap = playerLivery.metalness;
  playerAccentMat.normalMap = playerLivery.normal;
  playerAccentMat.aoMap = playerLivery.ao;

  // Canopy: fake glass. Real transmission costs a full extra scene render per
  // frame (three re-renders the opaque set into a transmission RT); at this
  // scale the look is carried by sharp tinted reflections, not by refraction.
  // Opaque-ish dark interior tint + Fresnel-weighted env reflection + clearcoat
  // reads identically as a cockpit canopy without the extra pass.
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x101c28,
    metalness: 0.25,
    roughness: 0.05,
    ior: 1.45,
    clearcoat: 1.0,
    clearcoatRoughness: 0.02,
    envMapIntensity: 3.0,
    transparent: true,
    opacity: 0.68,
  });

  // Engine nozzle: unlit HDR so bloom picks it up and tone mapping rolls it off.
  const engineMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 4.4, 9.0), toneMapped: true });

  const darkMat = new THREE.MeshStandardMaterial({
    color: 0x14181d,
    metalness: 0.75,
    roughness: 0.62,
    envMapIntensity: 0.9,
  });

  return { hullMat, accentMat, playerAccentMat, glassMat, engineMat, darkMat, maps: { hull, accent, playerLivery } };
}

// --- geometry helpers -------------------------------------------------------
function put(geo, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
  m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
  geo.applyMatrix4(m);
  return geo;
}

// mergeGeometries requires a consistent attribute set across every part.
function ensureUV(geo) {
  if (!geo.attributes.uv) {
    const n = geo.attributes.position.count;
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  return geo;
}

class Kit {
  constructor() { this.byGroup = [[], [], [], [], []]; }
  add(group, geo) { ensureUV(geo); this.byGroup[group].push(geo); return this; }
  merge() {
    const parts = [];
    for (let g = 0; g < this.byGroup.length; g++) {
      const raw = this.byGroup[g];
      if (!raw.length) continue;
      // ExtrudeGeometry is non-indexed while the primitives are indexed; mergeGeometries
      // refuses a mixed set, so normalise the whole group to one form.
      const mixed = raw.some((x) => !x.index);
      const list = mixed ? raw.map((x) => (x.index ? x.toNonIndexed() : x)) : raw;
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      parts.push({ group: g, geo: merged });
    }
    return { parts };
  }
}

// Build a delta-ish wing via extrusion of a planar profile.
function wingGeometry(span, rootChord, tipChord, thickness, sweep) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(rootChord, 0);
  s.lineTo(rootChord - sweep, thickness * 0.5);
  s.lineTo(tipChord + sweep * 0.2, thickness * 0.5);
  s.lineTo(0, thickness * 0.5);
  s.lineTo(-rootChord * 0.12, 0);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: thickness, bevelEnabled: true, bevelThickness: thickness * 0.32,
    bevelSize: thickness * 0.32, bevelSegments: 2, curveSegments: 2, steps: 1,
  });
  geo.rotateX(Math.PI / 2);
  return geo;
}

// ---------------------------------------------------------------------------
// Player fighter: ~18 m, twin nacelles, canopy, wingtip gun pods.
// Faces -Z (three.js forward).
// ---------------------------------------------------------------------------
export function buildPlayerShip() {
  const k = new Kit();

  // core fuselage: rounded hull along Z
  const body = new THREE.CylinderGeometry(1.55, 2.05, 11.5, 14, 3);
  k.add(G_HULL, put(body, { x: 0, y: 0, z: 0.4, rx: Math.PI / 2 }));

  // nose
  const nose = new THREE.ConeGeometry(1.55, 5.2, 14);
  k.add(G_HULL, put(nose, { x: 0, y: 0.05, z: -7.9, rx: -Math.PI / 2 }));

  // spine / dorsal fairing
  const spine = new THREE.CylinderGeometry(0.9, 1.7, 7.0, 10);
  k.add(G_HULL, put(spine, { x: 0, y: 1.25, z: 1.2, rx: Math.PI / 2, sy: 0.62 }));

  // canopy
  const canopy = new THREE.SphereGeometry(1.55, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.56);
  k.add(G_GLASS, put(canopy, { x: 0, y: 1.05, z: -3.4, sx: 0.86, sy: 0.78, sz: 1.9 }));

  // main delta wings
  const wl = wingGeometry(9.0, 5.4, 1.7, 0.42, 2.6);
  k.add(G_HULL, put(wl, { x: 1.4, y: -0.28, z: 1.0, ry: 0 }));
  const wr = wingGeometry(9.0, 5.4, 1.7, 0.42, 2.6);
  k.add(G_HULL, put(wr, { x: -1.4, y: -0.28, z: 1.0, ry: Math.PI }));

  // leading-edge extensions
  const lexL = wingGeometry(3.4, 2.6, 0.9, 0.2, 1.4);
  k.add(G_ACCENT, put(lexL, { x: 1.5, y: 0.05, z: -2.2 }));
  const lexR = wingGeometry(3.4, 2.6, 0.9, 0.2, 1.4);
  k.add(G_ACCENT, put(lexR, { x: -1.5, y: 0.05, z: -2.2, ry: Math.PI }));

  // wingtip gun pods
  for (const sgn of [-1, 1]) {
    const pod = new THREE.CylinderGeometry(0.42, 0.36, 5.6, 12);
    k.add(G_DARK, put(pod, { x: sgn * 5.5, y: -0.3, z: 0.6, rx: Math.PI / 2 }));
    const muzzle = new THREE.CylinderGeometry(0.3, 0.24, 0.9, 12);
    k.add(G_ENGINE, put(muzzle, { x: sgn * 5.5, y: -0.3, z: -2.6, rx: Math.PI / 2 }));
  }

  // twin engine nacelles
  for (const sgn of [-1, 1]) {
    const nac = new THREE.CylinderGeometry(1.22, 1.42, 7.4, 16);
    k.add(G_HULL, put(nac, { x: sgn * 2.85, y: -0.15, z: 2.6, rx: Math.PI / 2 }));
    const cowl = new THREE.TorusGeometry(1.3, 0.16, 8, 20);
    k.add(G_ACCENT, put(cowl, { x: sgn * 2.85, y: -0.15, z: 5.0 }));
    // nozzle interior: bright, scales with throttle
    const noz = new THREE.CylinderGeometry(0.98, 1.22, 1.9, 16, 1, true);
    k.add(G_ENGINE, put(noz, { x: sgn * 2.85, y: -0.15, z: 6.1, rx: Math.PI / 2 }));
    const nozzle = new THREE.CylinderGeometry(0.62, 0.95, 1.1, 16);
    k.add(G_DARK, put(nozzle, { x: sgn * 2.85, y: -0.15, z: 5.6, rx: Math.PI / 2 }));
  }

  // vertical stabilisers
  const finL = wingGeometry(2.4, 2.8, 1.0, 0.18, 1.6);
  k.add(G_ACCENT, put(finL, { x: 1.5, y: 0.4, z: 3.4, rz: Math.PI / 2 }));
  const finR = wingGeometry(2.4, 2.8, 1.0, 0.18, 1.6);
  k.add(G_ACCENT, put(finR, { x: -1.5, y: 0.4, z: 3.4, rz: -Math.PI / 2 }));

  // greebles: hardpoints, panels, antennae
  const rng = mulberry(90210);
  for (let i = 0; i < 26; i++) {
    const w = 0.25 + rng() * 0.7, h = 0.12 + rng() * 0.3, d = 0.4 + rng() * 1.5;
    const side = rng() < 0.5 ? 1 : -1;
    k.add(G_DARK, put(new THREE.BoxGeometry(w, h, d), {
      x: side * (0.9 + rng() * 1.1),
      y: -1.1 - rng() * 0.35,
      z: -4.5 + rng() * 8.5,
      ry: (rng() - 0.5) * 0.3,
    }));
  }
  // antenna whips
  for (const sgn of [-1, 1]) {
    const ant = new THREE.CylinderGeometry(0.03, 0.05, 2.6, 6);
    k.add(G_DARK, put(ant, { x: sgn * 0.7, y: 1.9, z: 2.2, rz: sgn * 0.22 }));
  }

  return k.merge();
}

// ---------------------------------------------------------------------------
// Enemy fighters. kind 0: light interceptor. kind 1: heavy gunship.
// ---------------------------------------------------------------------------
export function buildEnemyShip(kind) {
  const k = new Kit();
  if (kind === 0) {
    const body = new THREE.CylinderGeometry(1.15, 1.75, 9.5, 12, 2);
    k.add(G_HULL, put(body, { rx: Math.PI / 2 }));
    const nose = new THREE.ConeGeometry(1.15, 4.2, 12);
    k.add(G_HULL, put(nose, { z: -6.8, rx: -Math.PI / 2 }));
    const cab = new THREE.BoxGeometry(1.7, 1.1, 2.6);
    k.add(G_GLASS, put(cab, { y: 0.95, z: -2.4 }));

    // scythe wings
    for (const sgn of [-1, 1]) {
      const w = wingGeometry(6.4, 4.2, 1.2, 0.3, 3.2);
      k.add(G_HULL, put(w, { x: sgn * 1.2, y: -0.2, z: 1.2, ry: sgn > 0 ? 0 : Math.PI, rz: sgn * 0.16 }));
      const pod = new THREE.CylinderGeometry(0.34, 0.3, 4.4, 10);
      k.add(G_DARK, put(pod, { x: sgn * 4.4, y: -0.35, z: 0.2, rx: Math.PI / 2 }));
      const mz = new THREE.CylinderGeometry(0.24, 0.2, 0.8, 10);
      k.add(G_ENGINE, put(mz, { x: sgn * 4.4, y: -0.35, z: -2.2, rx: Math.PI / 2 }));
    }
    const eng = new THREE.CylinderGeometry(1.0, 1.2, 4.6, 14);
    k.add(G_HULL, put(eng, { z: 4.4, rx: Math.PI / 2 }));
    const noz = new THREE.CylinderGeometry(0.82, 1.02, 1.5, 14, 1, true);
    k.add(G_ENGINE, put(noz, { z: 6.2, rx: Math.PI / 2 }));
    const fin = wingGeometry(2.0, 2.4, 0.9, 0.16, 1.4);
    k.add(G_ACCENT, put(fin, { y: 0.5, z: 3.2, rz: Math.PI / 2 }));
    const rng = mulberry(1337);
    for (let i = 0; i < 18; i++) {
      k.add(G_DARK, put(new THREE.BoxGeometry(0.2 + rng() * 0.5, 0.1 + rng() * 0.22, 0.3 + rng() * 1.1), {
        x: (rng() - 0.5) * 2.4, y: -0.95 - rng() * 0.3, z: -3.5 + rng() * 7.5,
      }));
    }
  } else {
    // heavy gunship: blocky, wide, four nacelles
    const body = new THREE.BoxGeometry(4.6, 3.0, 13.0);
    k.add(G_HULL, put(body, { y: 0 }));
    const bridge = new THREE.BoxGeometry(3.0, 1.5, 4.4);
    k.add(G_HULL, put(bridge, { y: 2.1, z: -2.2 }));
    const win = new THREE.BoxGeometry(2.5, 0.9, 1.6);
    k.add(G_GLASS, put(win, { y: 2.2, z: -3.9 }));
    const prow = new THREE.ConeGeometry(2.4, 4.0, 6);
    k.add(G_HULL, put(prow, { z: -8.4, rx: -Math.PI / 2, sz: 1.4 }));
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const nac = new THREE.CylinderGeometry(0.85, 1.0, 5.2, 12);
        k.add(G_HULL, put(nac, { x: sx * 3.6, y: sz * 1.5 - 0.2, z: 2.4, rx: Math.PI / 2 }));
        const noz = new THREE.CylinderGeometry(0.68, 0.86, 1.3, 12, 1, true);
        k.add(G_ENGINE, put(noz, { x: sx * 3.6, y: sz * 1.5 - 0.2, z: 5.2, rx: Math.PI / 2 }));
      }
      const gun = new THREE.CylinderGeometry(0.5, 0.42, 6.4, 10);
      k.add(G_DARK, put(gun, { x: sx * 2.0, y: -1.7, z: -3.0, rx: Math.PI / 2 }));
      const gz = new THREE.CylinderGeometry(0.36, 0.28, 1.0, 10);
      k.add(G_ENGINE, put(gz, { x: sx * 2.0, y: -1.7, z: -6.4, rx: Math.PI / 2 }));
    }
    const rng = mulberry(4242);
    for (let i = 0; i < 34; i++) {
      k.add(G_ACCENT, put(new THREE.BoxGeometry(0.3 + rng() * 0.9, 0.2 + rng() * 0.6, 0.4 + rng() * 1.8), {
        x: (rng() - 0.5) * 4.4, y: (rng() - 0.5) * 2.8, z: -5.5 + rng() * 11,
      }));
    }
  }
  return k.merge();
}

function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
