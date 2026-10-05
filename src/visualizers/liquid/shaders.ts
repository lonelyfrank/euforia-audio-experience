import { traceGlsl } from '../shared/RollingTraces';
import { voiceGlsl } from '../shared/VoiceTextures';

export const MAX_RIBBONS = 8;
export const SHOCKS = 4;

export const vertexShader = /* glsl */ `
  varying vec2 vPos;
  void main() {
    vPos = (modelMatrix * vec4(position, 1.0)).xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/*
 * Everything that is the same for every pixel of a ribbon (phases,
 * amplitudes, colours) is computed on the CPU in update(); the shader only
 * sums the displacement terms per pixel. This keeps it light enough for
 * integrated GPUs (fewer live registers), which matters at 1080p+.
 */
export const fragmentShader = /* glsl */ `
  #define MAX_RIBBONS ${MAX_RIBBONS}
  #define SHOCKS ${SHOCKS}
  uniform float uHalfWidth;
  uniform float uWidth;
  uniform float uHorizonY;
  uniform int uRibbons;
  uniform float uLineWidth;
  uniform float uImprint;
  uniform float uShockGlow;
  uniform float uClock;
  uniform float uGlintRate;
  uniform vec3 uGlintColor;
  // Per ribbon: (base, cycles across the view, phase, amplitude) of its voice.
  uniform vec4 uSwell[MAX_RIBBONS];
  // Per ribbon: (frequency, phase, amplitude) of the mid curvature, frequency of the fine ripple.
  uniform vec4 uCurve[MAX_RIBBONS];
  // Per ribbon: phase and amplitude of the fine ripple, waveform and shock amplitudes.
  uniform vec4 uDetailTerms[MAX_RIBBONS];
  // Per ribbon: spectrum band (start, width), glint amount, trace height.
  uniform vec4 uBand[MAX_RIBBONS];
  uniform vec3 uBody[MAX_RIBBONS];
  // Per ribbon: edge colour and glow.
  uniform vec4 uEdge[MAX_RIBBONS];
  // Per shock ring: (age, amplitude).
  uniform vec4 uShocks[SHOCKS];
  uniform sampler2D tSpectrum;
  uniform sampler2D tWave;
  // Rolling traces (one row per ribbon) and voices (bass line, lead, air): each ribbon draws one voice.
  ${traceGlsl}
  ${voiceGlsl}
  uniform float uVoiceRow[MAX_RIBBONS];
  uniform float uDigital;
  uniform float uGraticule;
  // 1 without the water: the ground line is not an edge any more, so bodies and grid fade out above it.
  uniform float uOpen;
  uniform vec3 uGridColor;
  varying vec2 vPos;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  // Rings expanding from the scene centre, one per recent impact.
  float shockwave(float x) {
    float s = 0.0;
    for (int i = 0; i < SHOCKS; i++) {
      if (uShocks[i].y < 0.002) continue;
      float d = abs(x) - uShocks[i].x * 1.1;
      s += uShocks[i].y * exp(-d * d * 40.0) * cos(d * 28.0);
    }
    return s;
  }

  void main() {
    float v = vPos.x / (2.0 * uHalfWidth * uWidth) + 0.5;
    float lateral = 1.0 - smoothstep(0.9, 1.0, abs(v * 2.0 - 1.0));
    float taper = sin(clamp(v, 0.0, 1.0) * 3.14159265);
    float wave = (texture2D(tWave, vec2(v, 0.5)).r * 2.0 - 1.0) * taper;
    float shock = shockwave(vPos.x);
    float shockGlow = abs(shock) * uShockGlow;
    float mirror = abs(2.0 * v - 1.0);
    float px = fwidth(vPos.y) * uLineWidth;
    vec2 glintSeed = vec2(floor(v * 160.0), floor(uClock * 7.0));
    vec3 color = vec3(0.0);

    // Measuring grid, like an instrument's graticule: faint, only in the sky.
    float ground = mix(1.0, smoothstep(uHorizonY, uHorizonY + 0.35, vPos.y), uOpen);
    if (uGraticule > 0.0 && vPos.y > uHorizonY) {
      vec2 cell = vec2(vPos.x, vPos.y - uHorizonY) * 5.0;
      vec2 line = abs(fract(cell + 0.5) - 0.5) / fwidth(cell);
      float grid = 1.0 - min(min(line.x, line.y), 1.0);
      color += uGridColor * grid * uGraticule * ground;
    }

    for (int k = 0; k < MAX_RIBBONS; k++) {
      if (k >= uRibbons) break;
      vec4 swell = uSwell[k];
      vec4 curve = uCurve[k];
      vec4 terms = uDetailTerms[k];
      vec4 band = uBand[k];
      // Spectrum imprint: the ribbon's own band, its low end at the centre.
      float spectrum = texture2D(tSpectrum, vec2(band.x + mirror * band.y, 0.5)).r;
      // Rolling trace: what this band did, written at the centre and scrolling out to the edges.
      float trace = traceAt(float(k), float(MAX_RIBBONS), mirror);
      // The voice: one real cycle of the sound, repeated at a length set by its pitch; optionally stepped.
      float voice = voiceAt(uVoiceRow[k], v * swell.y + swell.z, uDigital);
      float y = swell.x
        + voice * swell.w
        + sin(v * curve.x + curve.y) * curve.z
        + sin(v * curve.w + terms.x) * terms.y
        + spectrum * uImprint * taper
        + wave * terms.z
        + shock * terms.w
        + trace * band.w * (1.0 - 0.55 * mirror);
      float d = vPos.y - y;
      // Body between the ribbon and the horizon.
      if (d < 0.0 && vPos.y > uHorizonY) color += uBody[k] * ground;
      // Bright edge, anti-aliased; glints only on the edge.
      float edge = 1.0 - smoothstep(0.0, px, abs(d));
      if (edge > 0.0) {
        vec4 e = uEdge[k];
        color += e.rgb * edge * (e.a + shockGlow);
        if (band.z > 0.0) {
          float r = hash(glintSeed + vec2(0.0, float(k) * 7.0));
          color += uGlintColor * step(1.0 - uGlintRate, r) * band.z * edge;
        }
      }
    }
    gl_FragColor = vec4(color * lateral, 1.0);
  }
`;

