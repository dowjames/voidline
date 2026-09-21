// Sim -> GPU sync layer. Reads world state, writes instance buffers.
// Hot path: no allocations per frame, buffers uploaded once per frame with needsUpdate.

import * as THREE from 'three';
import { G_HULL, G_ACCENT, G_GLASS, G_ENGINE, G_DARK } from './ships.js';

const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

function q2q(dst, s) { dst.set(s.x, s.y, s.z, s.w); return dst; }

// ---------------------------------------------------------------------------
// Ships: one InstancedMesh per (craft kind, material group).
// ---------------------------------------------------------------------------
export function createShipLayer(scene, partsByKind, mats, maxPerKind) {
  const layers = [];
  for (let kind = 0; kind < partsByKind.length; kind++) {
    const parts = partsByKind[kind].parts;
    const meshes = [];
    for (const part of parts) {
      const mat = mats[part.group];
      if (!mat) continue;
      const im = new THREE.InstancedMesh(part.geo, mat, maxPerKind);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Only the hull casts. The accent/engine/dark parts sit inside the hull's
      // shadow silhouette (or throw it into empty space at this ~9deg sun
      // elevation), so dropping them as casters is pixel-identical while cutting
      // the shadow pass from 4 caster meshes per craft to 1.
      im.castShadow = part.group === G_HULL;
      im.receiveShadow = part.group === G_HULL || part.group === G_ACCENT;
      im.frustumCulled = false;
      if (part.group === G_ENGINE) {
        im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(maxPerKind * 3).fill(1), 3);
        im.instanceColor.setUsage(THREE.DynamicDrawUsage);
      }
      im.count = 0;
      scene.add(im);
      meshes.push({ im, group: part.group });
    }
    layers.push({ kind, meshes });
  }

  return {
    layers,
    update(enemies) {
      for (let li = 0; li < layers.length; li++) {
        const L = layers[li];
        for (const m of L.meshes) m.im.count = 0;
      }
      for (let i = 0; i < enemies.length; i++) {
        const e = enemies[i];
        if (!e.alive) continue;
        const L = layers[e.kind] || layers[0];
        const glow = 0.55 + Math.min(1, Math.hypot(e.vel.x, e.vel.y, e.vel.z) / 150) * 1.6;
        const dmg = 1 - Math.max(0, e.health / e.maxHealth);
        for (const m of L.meshes) {
          if (m.im.count >= maxPerKind) break;
          const idx = m.im.count++;
          _v3.set(e.pos.x, e.pos.y, e.pos.z);
          q2q(_q, e.quat);
          _s.set(1, 1, 1);
          _m4.compose(_v3, _q, _s);
          m.im.setMatrixAt(idx, _m4);
          if (m.group === G_ENGINE) {
            _c.setRGB(glow * 0.55, glow * 1.0, glow * 2.1);
            m.im.setColorAt(idx, _c);
          } else if (m.group === G_HULL && dmg > 0.55) {
            // scorched hull as it takes damage
            const t = (dmg - 0.55) / 0.45;
            _c.setRGB(1 - t * 0.45, 1 - t * 0.55, 1 - t * 0.5);
            m.im.setColorAt(idx, _c);
          } else if (m.group === G_HULL) {
            _c.setRGB(1, 1, 1);
            m.im.setColorAt(idx, _c);
          }
        }
      }
      for (const L of layers) {
        for (const m of L.meshes) {
          m.im.instanceMatrix.needsUpdate = true;
          if (m.im.instanceColor) m.im.instanceColor.needsUpdate = true;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Player craft (single instance, animated directly).
// ---------------------------------------------------------------------------
export function createPlayerShip(scene, parts, mats) {
  const group = new THREE.Group();
  const engineMeshes = [];
  const navLights = [];
  for (const part of parts.parts) {
    const mat = mats[part.group];
    if (!mat) continue;
    const mesh = new THREE.Mesh(part.geo, mat);
    mesh.castShadow = part.group === G_HULL;
    mesh.receiveShadow = part.group === G_HULL || part.group === G_ACCENT;
    group.add(mesh);
    if (part.group === G_ENGINE) engineMeshes.push(mesh);
  }
  // navigation / strobe lights as bright sprites
  const navMat = new THREE.SpriteMaterial({ color: 0x66ccff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  for (const sgn of [-1, 1]) {
    const sp = new THREE.Sprite(navMat.clone());
    sp.position.set(sgn * 5.6, -0.3, 0.6);
    sp.scale.setScalar(1.5);
    group.add(sp);
    navLights.push(sp);
  }
  scene.add(group);
  return {
    group, engineMeshes, navLights,
    update(p, time) {
      group.position.set(p.pos.x, p.pos.y, p.pos.z);
      group.quaternion.set(p.quat.x, p.quat.y, p.quat.z, p.quat.w);
      const th = p.throttle;
      const g = 0.25 + th * 3.4;
      for (const m of engineMeshes) m.material.color.setRGB(g * 0.42, g * 0.85, g * 2.0);
      const blink = (Math.sin(time * 6.0) > 0.7) ? 3.2 : 0.12;
      navLights[0].material.opacity = blink;
      navLights[1].material.opacity = blink;
      group.visible = p.alive;
    },
  };
}

// ---------------------------------------------------------------------------
// Bullets: instanced glowing bolts (hot core + softer trail sheath).
// ---------------------------------------------------------------------------
export function createBulletLayer(scene, max) {
  const core = new THREE.CylinderGeometry(0.16, 0.16, 5.0, 8, 1, true);
  core.rotateX(Math.PI / 2);
  const sheath = new THREE.CylinderGeometry(0.5, 0.28, 9.0, 8, 1, true);
  sheath.rotateX(Math.PI / 2);

  const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const sheathMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: true, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.35 });

  const coreIm = new THREE.InstancedMesh(core, coreMat, max);
  const sheathIm = new THREE.InstancedMesh(sheath, sheathMat, max);
  for (const im of [coreIm, sheathIm]) {
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    im.count = 0;
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
    im.instanceColor.setUsage(THREE.DynamicDrawUsage);
    scene.add(im);
  }

  const UP = new THREE.Vector3(0, 0, 1);
  return {
    core: coreIm,
    sheath: sheathIm,
    setVisible(v) { coreIm.visible = v; sheathIm.visible = v; },
    update(bullets) {
      coreIm.count = 0; sheathIm.count = 0;
      for (let i = 0; i < bullets.length; i++) {
        const b = bullets[i];
        if (!b.alive) continue;
        const sp = Math.hypot(b.vel.x, b.vel.y, b.vel.z) || 1;
        _v3.set(b.vel.x / sp, b.vel.y / sp, b.vel.z / sp);
        _q.setFromUnitVectors(UP, _v3);
        const fade = Math.min(1, b.life / 0.35);
        _v3.set(b.pos.x, b.pos.y, b.pos.z);
        _s.set(1, 1, 1);
        _m4.compose(_v3, _q, _s);
        if (coreIm.count < max) {
          coreIm.setMatrixAt(coreIm.count++, _m4);
          // player bolts: cyan-white; enemy bolts: hot orange
          if (b.owner === 0) _c.setRGB(3.4 * fade, 5.2 * fade, 7.4 * fade);
          else _c.setRGB(6.2 * fade, 2.6 * fade, 0.7 * fade);
          coreIm.setColorAt(coreIm.count - 1, _c);
        }
        if (sheathIm.count < max) {
          sheathIm.setMatrixAt(sheathIm.count++, _m4);
          if (b.owner === 0) _c.setRGB(0.9 * fade, 2.2 * fade, 4.2 * fade);
          else _c.setRGB(4.0 * fade, 1.3 * fade, 0.25 * fade);
          sheathIm.setColorAt(sheathIm.count - 1, _c);
        }
      }
      coreIm.instanceMatrix.needsUpdate = true;
      sheathIm.instanceMatrix.needsUpdate = true;
      coreIm.instanceColor.needsUpdate = true;
      sheathIm.instanceColor.needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Asteroids: instanced, three noise-displaced variants for visual variety.
// ---------------------------------------------------------------------------
export function createAsteroidLayer(scene, max, asteroidMat) {
  const variants = [];
  for (let v = 0; v < 3; v++) {
    const g = new THREE.IcosahedronGeometry(1, 3);
    const pos = g.attributes.position;
    let seed = 1234 + v * 7717;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    // low-frequency lumps + high-frequency roughness
    const disp = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const f1 = Math.sin(x * 2.1 + v) * Math.cos(y * 1.7 - v) * Math.sin(z * 2.4 + v * 2);
      const f2 = Math.sin(x * 5.3 - y * 4.1 + z * 3.7);
      disp[i] = f1 * 0.20 + f2 * 0.06 + (rnd() - 0.5) * 0.035;
    }
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const l = Math.hypot(x, y, z) || 1;
      const d = 1 + disp[i];
      pos.setXYZ(i, x / l * d, y / l * d, z / l * d);
    }
    g.computeVertexNormals();
    const im = new THREE.InstancedMesh(g, asteroidMat, max);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.castShadow = true;
    im.receiveShadow = true;
    im.frustumCulled = false;
    im.count = 0;
    scene.add(im);
    variants.push(im);
  }
  return {
    variants,
    setVisible(v) { for (const im of variants) im.visible = v; },
    update(asteroids) {
      for (const v of variants) v.count = 0;
      const per = Math.ceil(max / variants.length) + 1;
      for (let i = 0; i < asteroids.length; i++) {
        const a = asteroids[i];
        if (!a.alive) continue;
        const vi = a.seedIdx % variants.length;
        const im = variants[vi];
        if (im.count >= per) continue;
        _v3.set(a.pos.x, a.pos.y, a.pos.z);
        q2q(_q, a.quat);
        _s.setScalar(a.radius);
        _m4.compose(_v3, _q, _s);
        const idx = im.count++;
        im.setMatrixAt(idx, _m4);
      }
      for (const v of variants) v.instanceMatrix.needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Particles: single Points cloud driven by the sim's SoA buffers.
// ---------------------------------------------------------------------------
export function createParticleLayer(scene, cap) {
  const geo = new THREE.BufferGeometry();
  const aPos = new Float32Array(cap * 3);
  const aCol = new Float32Array(cap * 3);
  const aSize = new Float32Array(cap);
  const aAlpha = new Float32Array(cap);
  geo.setAttribute('position', new THREE.BufferAttribute(aPos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aColor', new THREE.BufferAttribute(aCol, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setDrawRange(0, 0);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uPixelRatio: { value: 1 }, uScale: { value: 1 } },
    vertexShader: /* glsl */`
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aAlpha;
      varying vec3 vColor;
      varying float vAlpha;
      uniform float uPixelRatio;
      uniform float uScale;
      void main() {
        vColor = aColor;
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float atten = 320.0 / max(-mv.z, 1.0);
        gl_PointSize = clamp(aSize * atten * uPixelRatio * uScale, 1.0, 180.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c) * 2.0;
        float core = exp(-d * d * 4.5);
        float glow = exp(-d * 1.6) * 0.45;
        float a = (core + glow) * vAlpha;
        if (a < 0.006) discard;
        // HDR: hot particles blow through tone mapping into bloom
        gl_FragColor = vec4(vColor * a * 2.6, a);
      }
    `,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);

  return {
    points, mat,
    update(p) {
      const n = p.count;
      let w = 0;
      for (let i = 0; i < n; i++) {
        const life = p.life[i];
        if (life <= 0) continue;
        const t = life / p.maxLife[i];          // 1 -> 0
        const kind = p.kind[i];
        let alpha;
        if (kind === 5) alpha = Math.min(1, t * 3.0) * 0.5;          // dust: soft
        else if (kind === 1) alpha = Math.pow(t, 0.65);               // fireball
        else if (kind === 2) alpha = Math.pow(t, 0.4) * 0.85;        // embers
        else if (kind === 4) alpha = t * t;                           // shield
        else alpha = Math.min(1, t * 2.2);                           // sparks
        aPos[w * 3] = p.px[i]; aPos[w * 3 + 1] = p.py[i]; aPos[w * 3 + 2] = p.pz[i];
        const boost = kind === 1 ? 1.0 + (1 - t) * 1.6 : 1.0;
        aCol[w * 3] = p.r[i] * boost; aCol[w * 3 + 1] = p.g[i] * boost; aCol[w * 3 + 2] = p.b[i] * boost;
        aSize[w] = p.size[i] * (kind === 1 ? (0.35 + (1 - t) * 2.4) : 1.0);
        aAlpha[w] = alpha;
        w++;
      }
      geo.setDrawRange(0, w);
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aColor.needsUpdate = true;
      geo.attributes.aSize.needsUpdate = true;
      geo.attributes.aAlpha.needsUpdate = true;
    },
  };
}
