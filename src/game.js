// Scene assembly. Shared by the interactive page and the headless benchmark so
// both measure/render exactly the same thing.

import * as THREE from 'three';
import { createWorld, stepWorld, makeScriptedInput, PLANET_RADIUS, PLANET_ALT } from './core/sim.js';
import { createSkyDome, createStarField, createPlanet, createSun, bakeSkyCube, bakeEnvironment, SUN_DIR } from './render/environment.js';
import { createShipMaterials, buildPlayerShip, buildEnemyShip, G_GLASS } from './render/ships.js';
import { createPlayerShip, createShipLayer, createBulletLayer, createAsteroidLayer, createParticleLayer } from './render/entities.js';
import { createEffects } from './render/effects.js';
import { createCameraRig } from './render/camera.js';
import { createComposer } from './render/post.js';
import { lensDirt, hullMaps } from './render/textures.js';

const SKY_SCALE = 1.9e7;

export function createGame(canvas, opts = {}) {
  const seed = opts.seed ?? 'voidline';
  const width = opts.width || canvas.clientWidth || 1280;
  const height = opts.height || canvas.clientHeight || 720;
  const pixelRatio = opts.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
    logarithmicDepthBuffer: true,
    stencil: false,
  });
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = opts.exposure ?? 0.78;
  renderer.shadowMap.enabled = opts.shadows !== false;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap removed in r186; it silently downgraded to this
  renderer.shadowMap.autoUpdate = !opts.shadowStatic;
  if (opts.shadowStatic) renderer.shadowMap.needsUpdate = true;
  // The composer renders several passes; autoReset would leave us with only the
  // last fullscreen quad. Reset once per frame instead and read the frame total.
  renderer.info.autoReset = false;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(68, width / height, 0.5, 2.6e7);
  camera.position.set(0, 3, 18);

  // --- sky -----------------------------------------------------------------
  // The procedural nebula/sun shader is evaluated once into a half-float cube
  // map and used as the scene background: one texture sample per pixel per frame
  // instead of ~35 fBm octaves. The dome mesh is never drawn, so its ~12k
  // triangles go with it.
  const skyDome = createSkyDome(seed);
  const skyCube = bakeSkyCube(renderer, skyDome);
  scene.background = skyCube.texture;

  // Stars stay live -- they twinkle, and as Points they were never the expensive
  // part of the sky. The layer rides with the camera so they sit at infinity.
  const skyGroup = new THREE.Group();
  skyGroup.scale.setScalar(SKY_SCALE);
  const stars = createStarField(seed, opts.stars ?? 7000);
  skyGroup.add(stars);
  scene.add(skyGroup);

  const planet = createPlanet(seed, { planetTexSize: opts.planetTexSize || 2048 });
  scene.add(planet.group);

  const sun = createSun({ mapSize: opts.shadowMapSize, extent: opts.shadowExtent });
  scene.add(sun.group);
  // The shadow light and its target ride at the scene root (see createSun):
  // syncScene keeps light.position = player + SUN_DIR*4000 and
  // target = player in WORLD space so the ortho box tracks the fighter.
  scene.add(sun.light);
  scene.add(sun.light.target);
  scene.add(sun.bounce);

  // Image-based lighting baked from the same dome + stars: this is what makes
  // the hull metal read as real rather than as flat grey plastic.
  const envTex = bakeEnvironment(renderer, skyDome, stars);
  scene.environment = envTex;

  // The dome has finished its job as a bake source; nothing holds it live.
  skyDome.geometry.dispose();
  skyDome.material.dispose();

  // --- craft ---------------------------------------------------------------
  const mats = createShipMaterials(seed);
  const shipMats = [mats.hullMat, mats.playerAccentMat, mats.glassMat, mats.engineMat, mats.darkMat];
  const enemyMats = [mats.hullMat, mats.accentMat, mats.glassMat, mats.engineMat, mats.darkMat];

  const world = createWorld(seed, {
    enemies: opts.enemies ?? 24,
    bullets: opts.bullets ?? 320,
    particles: opts.particles ?? 2400,
    asteroids: opts.asteroids ?? 6,
  });

  const playerShip = createPlayerShip(scene, buildPlayerShip(), shipMats);
  const enemyParts = [buildEnemyShip(0), buildEnemyShip(1)];
  const shipLayer = createShipLayer(scene, enemyParts, enemyMats, world.cfg.maxEnemies);
  const bulletLayer = createBulletLayer(scene, world.cfg.maxBullets);

  const hm = hullMaps(seed + ':rock', 512);
  const rockMat = new THREE.MeshStandardMaterial({
    map: hm.color,
    roughnessMap: hm.roughness,
    normalMap: hm.normal,
    aoMap: hm.ao,
    color: 0x6b6459,
    metalness: 0.12,
    roughness: 1.0,
    normalScale: new THREE.Vector2(1.6, 1.6),
    envMapIntensity: 0.75,
  });
  const asteroidLayer = createAsteroidLayer(scene, world.cfg.maxAsteroids, rockMat);
  const particleLayer = createParticleLayer(scene, world.cfg.maxParticles);
  const fxLayer = createEffects(scene, opts.maxExplosions ?? 16, opts.maxFlashes ?? 48);
  const rig = createCameraRig(camera, { fov: opts.fov ?? 68 });

  const dirt = lensDirt(seed + ':dirt', 512);
  const post = createComposer(renderer, scene, camera, {
    width, height, pixelRatio,
    dirtTexture: dirt,
    bloomStrength: opts.bloomStrength ?? 0.62,
    bloomRadius: opts.bloomRadius ?? 0.62,
    bloomThreshold: opts.bloomThreshold ?? 0.55,
    lens: opts.lens,
  });

  // Diagnostic-only component ablation, driven by ?ablate=a,b,c.
  // Never enabled by the default harness path (opts.ablate is empty), so the
  // measured workload is untouched; this exists purely to attribute frame cost.
  const layers = {
    skyCube, stars, planetGroup: planet.group, playerShipGroup: playerShip.group,
    shipLayer, bulletLayer, asteroidLayer, particlePoints: particleLayer.points,
    fxLayer,
  };
  const ablate = String(opts.ablate || '');
  if (ablate) {
    const off = (k) => ablate.split(',').indexOf(k) >= 0;
    if (off('sky')) scene.background = null;
    if (off('stars')) stars.visible = false;
    if (off('planet')) planet.group.visible = false;
    if (off('ships')) {
      playerShip.group.visible = false;
      for (const L of shipLayer.layers) for (const m of L.meshes) m.im.visible = false;
    }
    if (off('bullets')) bulletLayer.setVisible(false);
    if (off('asteroids')) asteroidLayer.setVisible(false);
    if (off('particles')) particleLayer.points.visible = false;
    if (off('bloom')) post.bloom.enabled = false;
    if (off('lens')) post.lens.enabled = false;
    if (off('shadows')) renderer.shadowMap.enabled = false;
    if (off('glass')) {
      for (const L of shipLayer.layers) for (const m of L.meshes) if (m.group === G_GLASS) m.im.visible = false;
      playerShip.group.traverse((o) => { if (o.isMesh && o.material === mats.glassMat) o.visible = false; });
    }
  }

  let fxCursor = 0;
  let elapsed = 0;

  const api = {
    renderer, scene, camera, world, rig, post, planet, sun, playerShip, layers,
    mats, envTex, skyCube,
    quality: { shadows: opts.shadows !== false },

    // Advance the deterministic simulation and push state to the GPU.
    step(input) {
      stepWorld(world, input);
      return world;
    },

    syncScene(dt) {
      const p = world.player;
      playerShip.update(p, elapsed);
      shipLayer.update(world.enemies);
      bulletLayer.update(world.bullets);
      asteroidLayer.update(world.asteroids);
      particleLayer.update(world.particles);

      fxCursor = fxLayer.consume(world.fx, fxCursor);
      fxLayer.update(dt);

      // sky follows the camera
      skyGroup.position.copy(camera.position);
      // planet cloud drift + slow rotation
      planet.clouds.rotation.y += dt * 0.0035;
      planet.surface.rotation.y += dt * 0.0022;

      // keep the shadow camera centred on the fighter
      sun.light.position.set(
        p.pos.x + SUN_DIR.x * 4000,
        p.pos.y + SUN_DIR.y * 4000,
        p.pos.z + SUN_DIR.z * 4000);
      sun.light.target.position.set(p.pos.x, p.pos.y, p.pos.z);
      sun.light.target.updateMatrixWorld();
    },

    render(dt) {
      renderer.info.reset();
      elapsed += dt;
      stars.material.uniforms.uTime.value = elapsed;
      stars.material.uniforms.uPixelRatio.value = pixelRatio;
      particleLayer.mat.uniforms.uPixelRatio.value = pixelRatio;
      post.render(dt, elapsed);
    },

    frame(input, dt) {
      stepWorld(world, input);
      rig.update(world.player, dt);
      api.syncScene(dt);
      api.render(dt);
      return world;
    },

    setSize(w, h, pr) {
      const ratio = pr ?? pixelRatio;
      renderer.setPixelRatio(ratio);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      post.setSize(w, h, ratio);
    },

    dispose() {
      post.composer.dispose?.();
      skyCube.dispose();
      renderer.dispose();
    },
  };

  return api;
}

export { makeScriptedInput };
