import { hzToPosition } from '../../audio/visual-response/spectrum';

const LOW_END = hzToPosition(250).toFixed(4);
const MID_END = hzToPosition(2000).toFixed(4);

/**
 * GLSL: how audible the part of the spectrum at position `pos` (0..1) is,
 * from `uAudible` (x = low, y = mid, z = high; VisualResponseFrame.*Audible),
 * blended across the region borders. Elements tied to a band vanish with it.
 */
export const audibleGlsl = /* glsl */ `
  uniform vec3 uAudible;
  float audibleAt(float pos) {
    float lowMid = mix(uAudible.x, uAudible.y, smoothstep(${LOW_END} - 0.05, ${LOW_END} + 0.05, pos));
    return mix(lowMid, uAudible.z, smoothstep(${MID_END} - 0.05, ${MID_END} + 0.05, pos));
  }
`;
