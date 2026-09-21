// Post-processing chain.
//   RenderPass -> UnrealBloom (HDR) -> OutputPass (ACES + sRGB) -> LensPass
// LensPass fakes the camera optics: radial chromatic aberration, element dirt,
// vignetting, film grain and dithering. That last layer is what sells "footage"
// over "render".

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

const LensShader = {
  uniforms: {
    tDiffuse: { value: null },
    uDirt: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1280, 720) },
    uCA: { value: 0.0028 },
    uGrain: { value: 0.055 },
    uVignette: { value: 0.55 },
    uDirtAmt: { value: 0.10 },
    uBloomTint: { value: new THREE.Color(1.0, 0.985, 0.96) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform sampler2D uDirt;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform float uCA;
    uniform float uGrain;
    uniform float uVignette;
    uniform float uDirtAmt;
    uniform vec3 uBloomTint;

    float rnd(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
    }

    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r = length(c);

      // lateral chromatic aberration grows toward the frame edge
      float ca = uCA * (0.18 + r * r * 3.4);
      vec3 col;
      col.r = texture2D(tDiffuse, uv - c * ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv + c * ca * 1.06).b;

      // grime on the front element: scatters highlights, worst off-axis
      vec3 dirt = texture2D(uDirt, uv).rgb;
      float hl = max(max(col.r, col.g), col.b);
      col += dirt * uDirtAmt * (0.25 + r * 1.35) * (0.35 + hl * 1.4);

      // optical vignette
      float vig = smoothstep(1.02, 0.24, r * (1.0 + uVignette * 0.35));
      col *= mix(1.0, vig, uVignette);

      // subtle warm core / cool edge colour cast
      col *= mix(vec3(0.985, 0.99, 1.03), vec3(1.02, 1.0, 0.975), smoothstep(0.7, 0.0, r));

      // film grain: heavier in the shadows, like a high-ISO stock
      float g = rnd(uv * uResolution + vec2(uTime * 91.7, uTime * 57.3));
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col += (g - 0.5) * uGrain * (0.30 + 1.25 * (1.0 - clamp(lum, 0.0, 1.0)));

      // ordered-ish dither so deep-space gradients don't band
      col += (g - 0.5) * (1.0 / 255.0) * 1.5;

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export function createComposer(renderer, scene, camera, opts = {}) {
  const w = opts.width || 1280, h = opts.height || 720;

  const composer = new EffectComposer(renderer);
  composer.setSize(w, h);
  composer.setPixelRatio(opts.pixelRatio || 1);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(w, h),
    opts.bloomStrength ?? 0.62,
    opts.bloomRadius ?? 0.62,
    opts.bloomThreshold ?? 0.55);
  composer.addPass(bloom);

  const output = new OutputPass();
  composer.addPass(output);

  const lens = new ShaderPass(LensShader);
  if (opts.dirtTexture) lens.uniforms.uDirt.value = opts.dirtTexture;
  lens.uniforms.uResolution.value.set(w, h);
  if (opts.lens) {
    if (opts.lens.ca != null) lens.uniforms.uCA.value = opts.lens.ca;
    if (opts.lens.grain != null) lens.uniforms.uGrain.value = opts.lens.grain;
    if (opts.lens.vignette != null) lens.uniforms.uVignette.value = opts.lens.vignette;
    if (opts.lens.dirt != null) lens.uniforms.uDirtAmt.value = opts.lens.dirt;
  }
  composer.addPass(lens);

  return {
    composer, bloom, lens, output, renderPass,
    setSize(w2, h2, pr) {
      composer.setSize(w2, h2);
      if (pr) composer.setPixelRatio(pr);
      lens.uniforms.uResolution.value.set(w2, h2);
    },
    render(dt, time) {
      lens.uniforms.uTime.value = time;
      composer.render(dt);
    },
  };
}
