import { Color, Vector2 } from 'three';

/** Horizon line, as a fraction of the height from the top (Halo layout). */
export const HORIZON = 0.47;
/** Scene centre, as fractions of the window from the top-left (Halo layout). */
export const SCENE_CENTER = { x: 0.52, y: 0.38 };

/**
 * Final composition of the Halo frame, in linear colour:
 * 1. sky: crossfade of the outgoing/incoming scene + navy haze + stars;
 * 2. floor: the sky mirrored below the horizon with sinusoidal ripples,
 *    darkened toward the bottom edge; ripples and twinkle follow the level,
 *    so silence leaves a still picture;
 * 3. a thin luminous horizon line where the scene touches the water.
 */
export const CompositeShader = {
  name: 'HaloCompositeShader',
  uniforms: {
    tA: { value: null },
    tB: { value: null },
    uMix: { value: 1 },
    uTime: { value: 0 },
    uLevel: { value: 0 },
    uResolution: { value: new Vector2(1, 1) },
    uHorizon: { value: 1 - HORIZON },
    uCenter: { value: new Vector2(SCENE_CENTER.x, 1 - SCENE_CENTER.y) },
    uHaze: { value: new Color() },
    uSheen: { value: new Color() },
    uVoid: { value: new Color('#05060d') },
    uAbyss: { value: new Color('#0b0e24') },
    uFloor: { value: new Color('#03040a') },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tA;
    uniform sampler2D tB;
    uniform float uMix;
    uniform float uTime;
    uniform float uLevel;
    uniform vec2 uResolution;
    uniform float uHorizon;
    uniform vec2 uCenter;
    uniform vec3 uHaze;
    uniform vec3 uSheen;
    uniform vec3 uVoid;
    uniform vec3 uAbyss;
    uniform vec3 uFloor;
    varying vec2 vUv;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    vec3 scene(vec2 uv) {
      return mix(texture2D(tA, uv).rgb, texture2D(tB, uv).rgb, uMix);
    }

    // Background of the sky: void, a haze tinted by the palette, twinkling stars.
    vec3 backdrop(vec2 uv) {
      vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
      float d = length((uv - uCenter) * aspect);
      vec3 color = uVoid;
      color += uAbyss * smoothstep(1.1, 0.0, d) * 0.9;
      color += uHaze * smoothstep(0.75, 0.0, d) * (0.18 + uLevel * 0.06);

      // One star per cell, soft 1–2px dot, slow twinkle.
      vec2 grid = uv * uResolution / 26.0;
      vec2 cell = floor(grid);
      float r = hash(cell);
      if (r > 0.55) {
        vec2 pos = vec2(hash(cell + 7.1), hash(cell + 3.7));
        float dist = length((fract(grid) - pos) * 26.0);
        // Stars hold still in silence and twinkle with the sound.
        float twinkle = 0.2 + 0.35 * uLevel * sin(uTime * 1.3 + r * 40.0);
        color += vec3(0.62, 0.66, 1.0) * max(twinkle, 0.0) * 0.5 * smoothstep(1.4, 0.0, dist);
      }
      return color;
    }

    vec3 sky(vec2 uv) {
      return backdrop(uv) + scene(uv);
    }

    void main() {
      vec2 uv = vUv;
      vec3 color;
      float unit = min(uResolution.x, uResolution.y * 1.8);

      if (uv.y >= uHorizon) {
        color = sky(uv);
      } else {
        // 0 at the horizon, 1 at the bottom edge.
        float k = (uHorizon - uv.y) / uHorizon;
        float row = (uHorizon - uv.y) * uResolution.y * 0.5;
        // The water only moves with the sound: silence leaves a still mirror.
        float amp = (1.5 + k * k * 42.0) * (unit / 1400.0) * uLevel * 1.2;
        float dx = sin(row * 0.21 / (1.0 + k * 3.0) + uTime * 1.4) * amp + sin(row * 0.05 + uTime * 0.6) * amp * 0.8;
        vec2 mirrored = vec2(uv.x + dx / uResolution.x, uHorizon + (uHorizon - uv.y) * 1.02);
        mirrored.y = min(mirrored.y, 1.0);
        // Soft, wet reflection: a small vertical blur.
        float px = 1.5 / uResolution.y;
        vec3 reflection = (sky(mirrored) * 2.0 + sky(mirrored + vec2(0.0, px)) + sky(mirrored - vec2(0.0, px))) * 0.25;
        color = uFloor + reflection * pow(1.0 - k, 1.7) * 0.62;
        // Darken toward the bottom edge.
        float shade = k < 0.4 ? mix(0.08, 0.5, k / 0.4) : mix(0.5, 0.92, (k - 0.4) / 0.6);
        color = mix(color, uFloor, shade);
      }

      // Horizon sheen.
      float line = 1.0 - smoothstep(0.0, 1.5, abs(uv.y - uHorizon) * uResolution.y);
      float across = 1.0 - smoothstep(0.0, 0.35, abs(uv.x - uCenter.x));
      color += uSheen * line * across * (0.22 + uLevel * 0.18);

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};
