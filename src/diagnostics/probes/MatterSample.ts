/** Statistics of the observed prefix, not an estimate of the whole population. */
export function summarizeMatter(position: Float32Array, velocity: Float32Array, count: number) {
  let x = 0, y = 0, z = 0, speed = 0, maxSpeed = 0, kinetic = 0, valid = 0;
  for (let i = 0; i < count; i++) {
    const j = i * 4;
    if (![position[j], position[j + 1], position[j + 2], velocity[j], velocity[j + 1], velocity[j + 2]].every(Number.isFinite)) continue;
    x += position[j]; y += position[j + 1]; z += position[j + 2];
    const v = Math.hypot(velocity[j], velocity[j + 1], velocity[j + 2]);
    speed += v; maxSpeed = Math.max(maxSpeed, v); kinetic += v * v / 2; valid++;
  }
  if (!valid) return { count, invalid: count, x: null, y: null, z: null, dispersion: null, speed: null, maxSpeed: null, kinetic: null };
  x /= valid; y /= valid; z /= valid;
  let variance = 0;
  for (let i = 0; i < count; i++) {
    const j = i * 4;
    if (![position[j], position[j + 1], position[j + 2], velocity[j], velocity[j + 1], velocity[j + 2]].every(Number.isFinite)) continue;
    variance += (position[j] - x) ** 2 + (position[j + 1] - y) ** 2 + (position[j + 2] - z) ** 2;
  }
  return { count, invalid: count - valid, x, y, z, dispersion: Math.sqrt(variance / valid), speed: speed / valid, maxSpeed, kinetic: kinetic / valid };
}
