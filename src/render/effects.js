// Explosion / impact / muzzle FX. Pooled, allocation-free at runtime.

import * as THREE from 'three';
import { NOISE_GLSL } from './environment.js';
import { FX_EXPLOSION, FX_IMPACT, FX_MUZZLE, FX_SHIELD_HIT } from '../core/fx.js';

const _v = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Fireball: unit sphere, vertex-turbulent, HDR emissive.
// ---------------------------------------------------------------------------
function makeFireballMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uHeat: { value: 0.5 },
      uSeed: { value: 0 },
      uAlpha: { value: 1 },
      uTurb: { value: 0.5 },
    },
    vertexShader: /* glsl */`
      uniform float uTime;
      uniform float uSeed;
      uniform float uTurb;
      varying vec3 vNrm;
      varying vec3 vWorld;
      varying float vDisp;
      ${NOISE_GLSL}
      void main() {
        vNrm = normalize(mat3(modelMatrix) * normal);
        float n = fbm3(normal * 2.6 + vec3(uSeed) + uTime * 0.85, 5);
        vDisp = n;
        vec3 p = position + normal * (n - 0.5) * uTurb;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vNrm;
      varying vec3 vWorld;
      varying float vDisp;
      uniform float uHeat;
      uniform float uAlpha;
      void main() {
        vec3 v = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - abs(dot(normalize(vNrm), v)), 1.7);
        float g = clamp(vDisp * 1.45 + fres * 0.55, 0.0, 1.0);
        vec3 cool = mix(vec3(0.22, 0.05, 0.02), vec3(0.10, 0.16, 0.34), uHeat * 0.55);
        vec3 mid  = vec3(1.0, 0.42, 0.10);
        vec3 hot  = vec3(1.0, 0.92, 0.74);
        vec3 c = mix(cool, mid, smoothstep(0.05, 0.58, g));
        c = mix(c, hot, smoothstep(0.58, 1.0, g));
        c *= 3.2 + uHeat * 3.0;
        gl_FragColor = vec4(c * uAlpha, uAlpha);
      }
    `,
  });
}

function makeShockMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uAlpha: { value: 1 }, uTint: { value: new THREE.Color(0.7, 0.85, 1.0) } },
    vertexShader: /* glsl */`
      varying vec3 vNrm; varying vec3 vWorld;
      void main() {
        vNrm = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vNrm; varying vec3 vWorld;
      uniform float uAlpha; uniform vec3 uTint;
      void main() {
        vec3 v = normalize(cameraPosition - vWorld);
        float rim = pow(1.0 - abs(dot(normalize(vNrm), v)), 2.6);
        float a = rim * uAlpha;
        gl_FragColor = vec4(uTint * a * 4.0, a);
      }
    `,
  });
}

// ---------------------------------------------------------------------------
export function createEffects(scene, maxExplosions = 16, maxFlashes = 40) {
  const fireGeo = new THREE.SphereGeometry(1, 40, 28);
  const ringGeo = new THREE.SphereGeometry(1, 32, 20);

  const explosions = [];
  for (let i = 0; i < maxExplosions; i++) {
    const fb = new THREE.Mesh(fireGeo, makeFireballMaterial());
    const sw = new THREE.Mesh(ringGeo, makeShockMaterial());
    const light = new THREE.PointLight(0xffa044, 0, 400, 2);
    fb.visible = false; sw.visible = false; light.intensity = 0;
    scene.add(fb); scene.add(sw); scene.add(light);
    explosions.push({ fb, sw, light, active: false, t: 0, life: 1.6, scale: 10, heat: 0.5, seed: 0 });
  }

  const flashGeo = new THREE.SphereGeometry(1, 10, 8);
  const flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const flashes = [];
  for (let i = 0; i < maxFlashes; i++) {
    const m = new THREE.Mesh(flashGeo, flashMat.clone());
    m.visible = false;
    scene.add(m);
    flashes.push({ m, active: false, t: 0, life: 0.12, size: 1 });
  }

  let eIdx = 0, fIdx = 0;

  const api = {
    explosions, flashes,

    spawnExplosion(x, y, z, scale, heat, kind) {
      const e = explosions[eIdx];
      eIdx = (eIdx + 1) % maxExplosions;
      e.active = true; e.t = 0;
      e.life = 1.15 + Math.min(1.6, scale * 0.045);
      e.scale = Math.max(3, scale);
      e.heat = heat;
      e.seed = (x * 12.9898 + y * 78.233 + z * 37.719) % 100;
      e.fb.position.set(x, y, z);
      e.sw.position.set(x, y, z);
      e.light.position.set(x, y, z);
      e.light.color.setRGB(1.0, 0.62 + heat * 0.25, 0.32 + heat * 0.4);
      e.light.distance = e.scale * 22;
      e.fb.visible = true; e.sw.visible = true;
    },

    spawnFlash(x, y, z, size, r, g, b) {
      const f = flashes[fIdx];
      fIdx = (fIdx + 1) % maxFlashes;
      f.active = true; f.t = 0; f.size = size;
      f.m.position.set(x, y, z);
      f.m.material.color.setRGB(r, g, b);
      f.m.visible = true;
    },

    update(dt) {
      for (let i = 0; i < maxExplosions; i++) {
        const e = explosions[i];
        if (!e.active) continue;
        e.t += dt;
        const u = e.t / e.life;
        if (u >= 1) {
          e.active = false; e.fb.visible = false; e.sw.visible = false; e.light.intensity = 0;
          continue;
        }
        // fireball rises fast then stalls; keeps expanding slowly
        const grow = 1 - Math.exp(-u * 3.4);
        const radius = e.scale * (0.35 + grow * 1.15);
        e.fb.scale.setScalar(radius);
        e.fb.material.uniforms.uTime.value = e.t;
        e.fb.material.uniforms.uSeed.value = e.seed;
        e.fb.material.uniforms.uHeat.value = e.heat;
        e.fb.material.uniforms.uTurb.value = 0.22 + u * 0.85;
        e.fb.material.uniforms.uAlpha.value = Math.pow(1 - u, 1.35);

        // shockwave outruns the fireball and thins out
        const swR = e.scale * (0.6 + u * 5.2);
        e.sw.scale.setScalar(swR);
        e.sw.material.uniforms.uAlpha.value = Math.pow(1 - u, 2.6) * 0.85;

        // light: sharp attack, exponential decay
        e.light.intensity = Math.pow(1 - u, 2.2) * e.scale * 26;
      }

      for (let i = 0; i < maxFlashes; i++) {
        const f = flashes[i];
        if (!f.active) continue;
        f.t += dt;
        const u = f.t / f.life;
        if (u >= 1) { f.active = false; f.m.visible = false; continue; }
        f.m.scale.setScalar(f.size * (0.6 + u * 1.6));
        f.m.material.opacity = Math.pow(1 - u, 1.6);
      }
    },

    // Drain sim FX events into visual effects.
    consume(fx, cursor) {
      return fx.drain(cursor, (type, o) => {
        const d = fx.data;
        const x = d[o], y = d[o + 1], z = d[o + 2];
        if (type === FX_EXPLOSION) {
          api.spawnExplosion(x, y, z, d[o + 3], d[o + 4], d[o + 5]);
        } else if (type === FX_IMPACT) {
          const energy = d[o + 6];
          api.spawnFlash(x, y, z, 0.5 + Math.min(2.2, energy * 0.35), 3.2, 2.2, 1.0);
        } else if (type === FX_MUZZLE) {
          const pow = d[o + 6];
          const enemy = d[o + 8];
          if (enemy === 0) api.spawnFlash(x, y, z, 0.85 * pow, 3.0, 4.6, 7.0);
          else api.spawnFlash(x, y, z, 0.7 * pow, 6.0, 2.6, 0.8);
        } else if (type === FX_SHIELD_HIT) {
          const energy = d[o + 6];
          api.spawnFlash(x, y, z, 0.8 + Math.min(2.5, energy * 0.3), 0.9, 2.4, 5.0);
        }
      });
    },
  };
  return api;
}
