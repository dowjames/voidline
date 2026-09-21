// Procedural space environment: star field, nebula dome, sun, earth-like planet
// with atmospheric scattering, and a PMREM environment map generated from the sky
// so that ship metal reflects the actual scene (the single biggest photorealism lever).

import * as THREE from 'three';
import { planetMaps } from './textures.js';
import { PLANET_RADIUS, PLANET_ALT, PLANET_SURFACE_Y } from '../core/sim.js';

export const SUN_DIR = new THREE.Vector3(-0.42, 0.16, -0.89).normalize();

// Shadow map resolution and half-extent of the directional light's ortho frustum,
// both centred on the player. Together they set the world-space shadow texel:
// 2 * extent / mapSize.
export const SHADOW_MAP_SIZE = 2048;
export const SHADOW_EXTENT = 420;

export const NOISE_GLSL = /* glsl */`
  float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
  float hash31(vec3 p){ p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
  float vnoise3(vec3 x){
    vec3 i = floor(x); vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash31(i + vec3(0.0,0.0,0.0));
    float n100 = hash31(i + vec3(1.0,0.0,0.0));
    float n010 = hash31(i + vec3(0.0,1.0,0.0));
    float n110 = hash31(i + vec3(1.0,1.0,0.0));
    float n001 = hash31(i + vec3(0.0,0.0,1.0));
    float n101 = hash31(i + vec3(1.0,0.0,1.0));
    float n011 = hash31(i + vec3(0.0,1.0,1.0));
    float n111 = hash31(i + vec3(1.0,1.0,1.0));
    return mix(mix(mix(n000,n100,f.x), mix(n010,n110,f.x), f.y),
               mix(mix(n001,n101,f.x), mix(n011,n111,f.x), f.y), f.z);
  }
  float fbm3(vec3 p, int oct) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 8; i++) {
      if (i >= oct) break;
      s += a * vnoise3(p);
      p = p * 2.03 + vec3(11.7, 3.1, 7.9);
      a *= 0.5;
    }
    return s;
  }
`;

// ---------------------------------------------------------------------------
// Sky dome: nebula clouds + sun glow. Bake source only -- see bakeSkyCube below;
// the mesh itself is never drawn. Stars are separate Points (much cheaper).
// ---------------------------------------------------------------------------
export function createSkyDome(seed) {
  const geo = new THREE.SphereGeometry(1, 96, 64);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uSunDir: { value: SUN_DIR.clone() },
      uTime: { value: 0 },
      uNebula: { value: 1.0 },
      uExposure: { value: 1.0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vDir;
      uniform vec3 uSunDir;
      uniform float uTime;
      uniform float uNebula;
      uniform float uExposure;
      ${NOISE_GLSL}

      // wispy multi-octave nebula, two interleaved gas palettes
      float layerMask(vec3 d, float scale, float thresh, float soft) {
        float n = fbm3(d * scale + vec3(0.0, 0.0, uTime * 0.004), 6);
        n += 0.5 * fbm3(d * scale * 2.7 + vec3(31.0, 5.0, 12.0), 4);
        return smoothstep(thresh, thresh + soft, n);
      }

      void main() {
        vec3 d = normalize(vDir);

        // base: deep space, very slightly blue, never pure black (zodiacal light)
        vec3 col = vec3(0.006, 0.0075, 0.012);

        // galactic band: a dense dust lane across the sky
        float band = exp(-pow(dot(d, normalize(vec3(0.26, 0.86, -0.43))) * 3.1, 2.0));

        float n1 = layerMask(d, 2.6, 0.62, 0.42);
        float n2 = layerMask(d, 4.9, 0.70, 0.36);
        float n3 = layerMask(d, 9.3, 0.78, 0.30);

        vec3 gasA = vec3(0.16, 0.34, 0.78);   // ionised oxygen - blue
        vec3 gasB = vec3(0.62, 0.18, 0.34);   // hydrogen alpha - crimson
        vec3 gasC = vec3(0.72, 0.52, 0.24);   // dust scatter - amber

        float bandAmt = band * 1.0 + 0.22;
        col += gasA * n1 * 0.30 * bandAmt * uNebula;
        col += gasB * n2 * 0.22 * bandAmt * uNebula;
        col += gasC * n3 * 0.10 * bandAmt * uNebula;

        // dark dust lanes carving through the bright band
        float dust = smoothstep(0.42, 0.62, fbm3(d * 7.0 + vec3(4.0), 5));
        col *= mix(1.0, 1.0 - dust * 0.75, band * 0.9);

        // the sun: tight disc + multi-scale corona + forward scatter halo
        float sd = max(dot(d, uSunDir), 0.0);
        float disc = smoothstep(0.99965, 0.99985, sd);
        float corona = pow(sd, 220.0) * 6.0;
        float inner  = pow(sd, 26.0) * 0.85;
        float outer  = pow(sd, 5.0) * 0.16;
        col += vec3(1.0, 0.94, 0.82) * disc * 140.0;
        col += vec3(1.0, 0.80, 0.52) * corona;
        col += vec3(1.0, 0.72, 0.44) * inner;
        col += vec3(0.55, 0.48, 0.62) * outer;

        gl_FragColor = vec4(col * uExposure, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

// ---------------------------------------------------------------------------
// Sky bake.
//
// The dome above is the most expensive thing in the frame: ~35 fBm octaves per
// pixel, across the whole screen, every frame, for an image whose only animated
// input is a uTime drift too small to see. So it is evaluated once at load into
// a cube map, and `scene.background` turns every later frame into a single
// texture sample.
//
// The target MUST be half-float. The sun disc is written at 140.0 and the
// corona / inner / outer scatter terms all run well over 1.0; UnrealBloom's
// threshold reads those over-range values. An 8-bit bake would clamp the sun to
// white and the glow would collapse.
//
// 1024 per face: at the sun's position on its face a texel subtends ~0.083deg
// against a ~0.094deg screen pixel, so the 1.5deg-radius disc keeps a crisp
// edge instead of smearing, and the finest nebula octave (n3's top octave,
// ~0.19deg) stays above the sampling limit. Mips cover the ~1.7x minification
// that appears near cube face corners.
// ---------------------------------------------------------------------------
export const SKY_CUBE_SIZE = 1024;

export function bakeSkyCube(renderer, skyDome, size = SKY_CUBE_SIZE) {
  const cubeRT = new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearMipmapLinearFilter,
    generateMipmaps: true,
  });

  const bakeScene = new THREE.Scene();
  bakeScene.add(skyDome);
  new THREE.CubeCamera(0.05, 10, cubeRT).update(renderer, bakeScene);
  bakeScene.remove(skyDome);

  return cubeRT;
}

// ---------------------------------------------------------------------------
// Star field: point sources with blackbody colours and a realistic magnitude
// distribution (lots of dim stars, a handful of bright ones).
// ---------------------------------------------------------------------------
export function createStarField(seed, count = 7000) {
  let s = 2166136261;
  const rnd = () => {
    s ^= s + 0x6d2b79f5; let t = s;
    t = Math.imul(t ^ (t >>> 15), 2246822507);
    t ^= t + Math.imul(t ^ (t >>> 13), 3266489919);
    return ((t ^= t >>> 16) >>> 0) / 4294967296;
  };
  for (let i = 0; i < 40; i++) rnd();

  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const siz = new Float32Array(count);
  const pha = new Float32Array(count);

  // approximate blackbody locus, cool -> hot
  const bb = (t) => {
    // t in 0..1 -> 2400K..12000K
    const k = 2400 + t * 9600;
    let r, g, b;
    if (k < 6600) { r = 255; g = 99.47 * Math.log(k / 100) - 161.12; b = k < 1900 ? 0 : 138.52 * Math.log(k / 100 - 10) - 305.04; }
    else { r = 329.7 * Math.pow(k - 6000, -0.1332); g = 288.12 * Math.pow(k - 6000, -0.0755); b = 255; }
    return [Math.max(0, Math.min(255, r)) / 255, Math.max(0, Math.min(255, g)) / 255, Math.max(0, Math.min(255, b)) / 255];
  };

  for (let i = 0; i < count; i++) {
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    pos[i * 3] = r * Math.cos(th);
    pos[i * 3 + 1] = u;
    pos[i * 3 + 2] = r * Math.sin(th);

    // magnitude^2 weighting: many faint, few bright
    const m = Math.pow(rnd(), 3.2);
    const bright = 0.10 + m * 3.4;
    const c = bb(0.12 + rnd() * 0.88);
    col[i * 3] = c[0] * bright;
    col[i * 3 + 1] = c[1] * bright;
    col[i * 3 + 2] = c[2] * bright;
    siz[i] = 0.9 + m * 4.2;
    pha[i] = rnd();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(pha, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uScale: { value: 1 },
    },
    vertexShader: /* glsl */`
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aPhase;
      varying vec3 vColor;
      varying float vTwinkle;
      uniform float uTime;
      uniform float uPixelRatio;
      uniform float uScale;
      void main() {
        vColor = aColor;
        // atmospheric-style scintillation, tiny and fast
        vTwinkle = 0.86 + 0.14 * sin(uTime * 7.0 + aPhase * 62.8);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPixelRatio * uScale * vTwinkle;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vColor;
      varying float vTwinkle;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c) * 2.0;
        // airy diffraction-ish profile: sharp core, soft halo
        float core = exp(-d * d * 9.0);
        float halo = exp(-d * 2.2) * 0.28;
        float a = core + halo;
        if (a < 0.004) discard;
        gl_FragColor = vec4(vColor * a, a);
      }
    `,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = -999;
  return points;
}

// ---------------------------------------------------------------------------
// Planet: surface + cloud deck + atmospheric limb scattering.
// ---------------------------------------------------------------------------
export function createPlanet(seed, opts = {}) {
  const maps = planetMaps(seed, opts.planetTexSize || 2048);
  const group = new THREE.Group();
  const R = PLANET_RADIUS;

  const surfGeo = new THREE.SphereGeometry(R, 192, 128);
  const surfMat = new THREE.MeshStandardMaterial({
    map: maps.color,
    roughnessMap: maps.roughness,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(1.25, 1.25),
    metalness: 0.02,
    roughness: 1.0,
  });
  // Inject high-frequency surface detail so the ground stays crisp at low altitude:
  // the equirect map is ~20 km/px, so near the surface we add GPU noise on top.
  surfMat.onBeforeCompile = (sh) => {
    sh.uniforms.uDetail = { value: 1.0 };
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <common>',
      '#include <common>\nuniform float uDetail;'
    );
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      /* glsl */`
        #include <normal_fragment_maps>
        {
          vec3 dp = vViewPosition * 0.00035;
          float n1 = fract(sin(dot(dp.xy + dp.z, vec2(12.9898, 78.233))) * 43758.5453);
          float n2 = fract(sin(dot(dp.yz + dp.x, vec2(39.346, 11.135))) * 24634.6345);
          float bump = (n1 + n2 - 1.0) * 0.5;
          normal = normalize(normal + vec3(bump * 0.16, bump * 0.13, 0.0) * uDetail);
        }
      `);
  };
  const surface = new THREE.Mesh(surfGeo, surfMat);
  surface.receiveShadow = true;
  group.add(surface);

  const cloudGeo = new THREE.SphereGeometry(R * 1.0035, 128, 96);
  const cloudMat = new THREE.MeshStandardMaterial({
    alphaMap: maps.clouds,
    color: 0xffffff,
    transparent: true,
    roughness: 0.95,
    metalness: 0.0,
    depthWrite: false,
  });
  const clouds = new THREE.Mesh(cloudGeo, cloudMat);
  group.add(clouds);

  // Rayleigh-ish limb glow: strong at the terminator, blue-white toward the sun.
  const atmoGeo = new THREE.SphereGeometry(R * 1.028, 128, 96);
  const atmoMat = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
    depthWrite: false,
    uniforms: {
      uSunDir: { value: SUN_DIR.clone() },
      uDayColor: { value: new THREE.Color(0.30, 0.55, 1.0) },
      uDuskColor: { value: new THREE.Color(0.95, 0.42, 0.18) },
      uPower: { value: 3.1 },
      uIntensity: { value: 1.35 },
    },
    vertexShader: /* glsl */`
      varying vec3 vNrm;
      varying vec3 vWorld;
      void main() {
        vNrm = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vNrm;
      varying vec3 vWorld;
      uniform vec3 uSunDir;
      uniform vec3 uDayColor;
      uniform vec3 uDuskColor;
      uniform float uPower;
      uniform float uIntensity;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float rim = 1.0 - max(dot(vNrm, viewDir), 0.0);
        rim = pow(rim, uPower);
        float sun = dot(vNrm, uSunDir);
        // terminator band glows warm; the day side scatters blue
        float dusk = exp(-pow((sun - 0.02) * 3.4, 2.0));
        float day = smoothstep(-0.15, 0.55, sun);
        vec3 c = mix(uDuskColor * 1.5, uDayColor, day * 0.85 + dusk * 0.15);
        float a = rim * uIntensity * (0.25 + day * 0.9 + dusk * 0.8);
        gl_FragColor = vec4(c * a, a);
      }
    `,
  });
  const atmo = new THREE.Mesh(atmoGeo, atmoMat);
  group.add(atmo);

  group.position.set(0, PLANET_SURFACE_Y + R, 0);
  return { group, surface, clouds, atmo, surfMat, cloudMat, atmoMat };
}

// ---------------------------------------------------------------------------
// Sun: HDR disc + corona sprite, plus the key directional light and shadows.
// ---------------------------------------------------------------------------
export function createSun(opts = {}) {
  const group = new THREE.Group();
  const dist = 9.0e6;
  group.position.copy(SUN_DIR).multiplyScalar(dist);

  const discMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.96, 0.90) });
  discMat.toneMapped = true;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(3.2e5, 64), discMat);
  disc.material.color.setRGB(28, 26, 22); // HDR: blows out through tone mapping
  disc.lookAt(0, 0, 0);
  group.add(disc);

  const corona = new THREE.Sprite(new THREE.SpriteMaterial({
    color: new THREE.Color(1.0, 0.66, 0.34),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.55,
  }));
  corona.scale.setScalar(2.6e6);
  group.add(corona);

  const light = new THREE.DirectionalLight(0xfff2e0, 4.2);
  light.position.copy(SUN_DIR).multiplyScalar(4000);
  light.target.position.set(0, 0, 0);
  light.castShadow = true;
  const mapSize = opts.mapSize ?? SHADOW_MAP_SIZE;
  light.shadow.mapSize.set(mapSize, mapSize);
  light.shadow.camera.near = 1;
  light.shadow.camera.far = 9000;
  const s = opts.extent ?? SHADOW_EXTENT;
  light.shadow.camera.left = -s; light.shadow.camera.right = s;
  light.shadow.camera.top = s; light.shadow.camera.bottom = -s;
  light.shadow.bias = -0.0008;
  light.shadow.normalBias = 0.6;
  // The light and its target MUST live at the scene root, not inside this
  // group: the shadow camera is placed from the light's WORLD matrix, and the
  // +/-extent x [near,far] box has to bracket the player. Parented here it
  // would sit 9e6 units away from the ship and the player would fall past
  // `far`, leaving the shadow map empty of player content. game.js adds both
  // to the scene and keeps them centred on the fighter every frame.

  // faint fill from the planet's albedo so shadowed hulls aren't pitch black
  const bounce = new THREE.HemisphereLight(0x2a4a7a, 0x0a0d14, 0.55);
  return { group, light, bounce, disc, corona };
}

// ---------------------------------------------------------------------------
// PMREM environment map baked from the sky dome + stars.
//
// Deliberately still fromScene() rather than fromCubemap(skyCube): this bake is
// already load-only and costs nothing per frame, so there is no perf reason to
// move it -- and fromCubemap() sizes the PMREM from the input face
// (PMREMGenerator._setSize(texture.image[0].width)), so a 1024 cube would make
// it allocate a 3072x4096 RGBA16F target plus an equal ping-pong, ~100 MB of
// VRAM for a scene on a hard budget. fromScene() keeps it at its default 256
// and keeps the star speckle and the 0.02 rad pre-blur the hull reflections
// are currently tuned against.
// ---------------------------------------------------------------------------
export function bakeEnvironment(renderer, skyDome, starField) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envScene = new THREE.Scene();
  const dome = skyDome.clone();
  dome.material = skyDome.material;
  envScene.add(dome);
  const stars = starField.clone();
  stars.material = starField.material;
  envScene.add(stars);
  const rt = pmrem.fromScene(envScene, 0.02, 1, 20);
  pmrem.dispose();
  return rt.texture;
}
